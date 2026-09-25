from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken
from users.models import CustomUser, StudentProfile
from universities.models import University, Program
from applications.models import ApplicationProject
from documents.models import Document, DocumentVersion, DocumentComment


def auth(client, user):
    token = RefreshToken.for_user(user)
    client.credentials(HTTP_AUTHORIZATION=f'Bearer {token.access_token}')


class CommentVersionFlowTests(APITestCase):
    def setUp(self):
        self.consultant = CustomUser.objects.create_user(
            'c1', password='x', role=CustomUser.ROLE_CONSULTANT)
        self.student = CustomUser.objects.create_user(
            's1', password='x', role=CustomUser.ROLE_STUDENT)
        StudentProfile.objects.create(user=self.student,
                                      consultant=self.consultant)
        uni = University.objects.create(name='U', country='US', city='NYC')
        prog = Program.objects.create(university=uni, name='CS',
                                      degree_level='master')
        self.app = ApplicationProject.objects.create(
            student=self.student, university=uni, program=prog)

    def save_version(self, client, content):
        r = client.post('/api/documents/versions/', {
            'document': self.doc.id, 'content': content}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        return r.data

    def test_full_flow(self):
        # 学生创建文书
        c = self.client
        auth(c, self.student)
        r = c.post('/api/documents/documents/', {
            'application': self.app.id, 'document_type': 'ps',
            'title': 'PS'}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        self.doc = Document.objects.get(id=r.data['id'])

        # v1：学生保存第一版
        v1 = self.save_version(c, 'the quick brown fox')

        # 学生不能加批注
        r = c.post('/api/documents/comments/', {
            'document': self.doc.id, 'version': v1['id'],
            'content': '选中的批注', 'start_position': 0, 'end_position': 3,
            'highlighted_text': 'the'}, format='json')
        self.assertEqual(r.status_code, 403)

        # 顾问未选中文字不能加批注
        auth(c, self.consultant)
        r = c.post('/api/documents/comments/', {
            'document': self.doc.id, 'content': '空批注'}, format='json')
        self.assertEqual(r.status_code, 400, r.content)

        # 区间与高亮文字不一致也不行
        r = c.post('/api/documents/comments/', {
            'document': self.doc.id, 'version': v1['id'],
            'content': 'x', 'start_position': 0, 'end_position': 3,
            'highlighted_text': 'THE'}, format='json')
        self.assertEqual(r.status_code, 400)

        # 顾问明确选中高亮文字 → 批注生效（active）
        r = c.post('/api/documents/comments/', {
            'document': self.doc.id, 'version': v1['id'],
            'content': '开头再改改', 'start_position': 0, 'end_position': 3,
            'highlighted_text': 'the'}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        comment_id = r.data['id']
        self.assertEqual(r.data['status'], 'active')

        # 列表计数：最新稿 1 条有效，0 条待处理
        r = c.get(f'/api/documents/documents/{self.doc.id}/')
        self.assertEqual(r.data['active_comments_count'], 1)
        self.assertEqual(r.data['pending_comments_count'], 0)

        # 学生保存 v2 → 旧批注自动转为 pending，不再影响最新稿
        content_v2 = 'a the quick brown fox the end'
        r = self.save_version(c, content_v2)
        v2 = r
        self.doc.refresh_from_db()
        old = DocumentComment.objects.get(id=comment_id)
        self.assertEqual(old.status, 'pending')
        self.assertEqual(old.version_id, v1['id'])

        r = c.get(f'/api/documents/documents/{self.doc.id}/')
        self.assertEqual(r.data['active_comments_count'], 0)
        self.assertEqual(r.data['pending_comments_count'], 1)

        # pending 批注不出现在 active 过滤结果中
        r = c.get('/api/documents/comments/',
                  {'document_id': self.doc.id, 'status': 'active'})
        self.assertEqual(r.data['count'], 0)

        # 未重新绑定时，顾问不能直接绑到旧版本/错误区间
        r = c.post(f'/api/documents/comments/{comment_id}/rebind/', {
            'version': v1['id'], 'start_position': 0, 'end_position': 3,
            'highlighted_text': 'the'}, format='json')
        self.assertEqual(r.status_code, 400)

        # 同一段文字 "the" 在 v2 出现两次，系统不自动挑选：
        # 顾问必须显式给出位置；这里选第二处 (22,25)
        self.assertEqual(content_v2[22:25], 'the')
        r = c.post(f'/api/documents/comments/{comment_id}/rebind/', {
            'version': v2['id'], 'start_position': 22, 'end_position': 25,
            'highlighted_text': 'the'}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.data['status'], 'active')
        self.assertEqual(r.data['version_number'], 2)
        old.refresh_from_db()
        self.assertEqual(old.version_id, v2['id'])

        r = c.get(f'/api/documents/documents/{self.doc.id}/')
        self.assertEqual(r.data['active_comments_count'], 1)
        self.assertEqual(r.data['pending_comments_count'], 0)

        # 学生可解决批注
        auth(c, self.student)
        r = c.post(f'/api/documents/comments/{comment_id}/resolve/')
        self.assertEqual(r.status_code, 200)

        # 已解决的批注不计入任何待办数量
        r = c.get(f'/api/documents/documents/{self.doc.id}/')
        self.assertEqual(r.data['active_comments_count'], 0)
        self.assertEqual(r.data['pending_comments_count'], 0)

        # 再保存 v3：已解决批注不会被翻出
        self.save_version(c, 'a the quick brown fox the end!')
        r = c.get(f'/api/documents/documents/{self.doc.id}/')
        self.assertEqual(r.data['active_comments_count'], 0)
        self.assertEqual(r.data['pending_comments_count'], 0)
