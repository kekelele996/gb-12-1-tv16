from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APITestCase

from applications.models import ApplicationProject
from universities.models import Program, University
from .models import Document, DocumentComment, DocumentVersion

User = get_user_model()


class DocumentCommentVersionFlowTests(APITestCase):
    """学生/顾问交替保存版本时，批注的失效与重新绑定流程"""

    def setUp(self):
        self.student = User.objects.create_user(
            username='student1', password='pass', role='student'
        )
        self.consultant = User.objects.create_user(
            username='consultant1', password='pass', role='consultant'
        )
        university = University.objects.create(name='测试大学', country='美国', city='波士顿')
        program = Program.objects.create(
            university=university, name='计算机科学', degree_level='master'
        )
        self.application = ApplicationProject.objects.create(
            student=self.student, university=university, program=program
        )
        self.document = Document.objects.create(
            application=self.application,
            document_type='ps',
            title='PS 初稿',
            created_by=self.student,
        )

    def _create_version(self, content, user=None):
        self.client.force_authenticate(user or self.student)
        response = self.client.post(
            reverse('document-versions-list'),
            {'document': self.document.id, 'content': content},
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.document.refresh_from_db()
        return response

    def _create_comment(self, content='这里需要修改', highlighted_text='梦想', user=None):
        self.client.force_authenticate(user or self.consultant)
        response = self.client.post(
            reverse('document-comments-list'),
            {'document': self.document.id, 'content': content,
             'highlighted_text': highlighted_text},
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.data)
        return DocumentComment.objects.get(id=response.data['id'])

    def test_new_comment_binds_to_current_version(self):
        self._create_version('我的梦想是改变世界。')
        comment = self._create_comment()
        self.assertEqual(comment.version, self.document.current_version)
        self.assertEqual(comment.status, DocumentComment.STATUS_ACTIVE)
        self.assertFalse(comment.is_resolved)

    def test_saving_new_version_outdates_active_comments(self):
        self._create_version('我的梦想是改变世界。')
        comment = self._create_comment()
        reply = DocumentComment.objects.create(
            document=self.document, version=comment.version,
            author=self.student, content='收到，我来改', parent=comment,
        )

        response = self._create_version('我的梦想是用技术改变世界。')

        comment.refresh_from_db()
        reply.refresh_from_db()
        self.assertEqual(comment.status, DocumentComment.STATUS_OUTDATED)
        self.assertEqual(reply.status, DocumentComment.STATUS_OUTDATED)
        # 旧批注留作历史，仍指向旧版本
        self.assertEqual(comment.version.version_number, 1)
        # 响应中的待处理数量只计顶层批注（回复随批注线程一起转换）
        self.assertEqual(response.data['outdated_comments_count'], 1)

        # 旧批注不再影响最新稿：有效 0 条，待处理 1 条
        self.client.force_authenticate(self.student)
        doc_response = self.client.get(
            reverse('documents-detail', args=[self.document.id])
        )
        self.assertEqual(doc_response.data['active_comments_count'], 0)
        self.assertEqual(doc_response.data['outdated_comments_count'], 1)

    def test_rebind_requires_explicit_matching_position(self):
        self._create_version('我的梦想是改变世界。')
        comment = self._create_comment()
        new_content = '全新开头。我的梦想是用技术改变世界。'
        self._create_version(new_content)
        comment.refresh_from_db()
        self.assertEqual(comment.status, DocumentComment.STATUS_OUTDATED)

        self.client.force_authenticate(self.consultant)
        url = reverse('document-comments-rebind', args=[comment.id])

        # 文本与指定区间不一致 -> 拒绝
        response = self.client.post(url, {
            'start_position': 0, 'end_position': 2,
            'highlighted_text': '梦想',
        }, format='json')
        self.assertEqual(response.status_code, 400)

        # 缺少明确位置 -> 拒绝，系统不自动挑选
        response = self.client.post(url, {'highlighted_text': '梦想'}, format='json')
        self.assertEqual(response.status_code, 400)

        # 顾问明确选中正确区间 -> 重新生效
        start = new_content.index('梦想')
        response = self.client.post(url, {
            'start_position': start,
            'end_position': start + 2,
            'highlighted_text': '梦想',
        }, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        comment.refresh_from_db()
        self.assertEqual(comment.status, DocumentComment.STATUS_ACTIVE)
        self.assertEqual(comment.version, self.document.current_version)
        self.assertEqual(comment.start_position, start)

    def test_rebind_rejects_student_and_resolved(self):
        self._create_version('我的梦想是改变世界。')
        comment = self._create_comment()
        self._create_version('我的梦想是用技术改变世界。')

        url = reverse('document-comments-rebind', args=[comment.id])
        payload = {'start_position': 2, 'end_position': 4, 'highlighted_text': '梦想'}

        # 学生不能执行重新绑定
        self.client.force_authenticate(self.student)
        response = self.client.post(url, payload, format='json')
        self.assertEqual(response.status_code, 403)

        # 已解决的批注无需重新绑定
        self.client.force_authenticate(self.consultant)
        self.client.post(reverse('document-comments-resolve', args=[comment.id]))
        comment.refresh_from_db()
        self.assertEqual(comment.status, DocumentComment.STATUS_RESOLVED)
        self.assertTrue(comment.is_resolved)
        response = self.client.post(url, payload, format='json')
        self.assertEqual(response.status_code, 400)

    def test_locate_returns_all_matches_without_picking(self):
        # 同一段文字在新稿中出现多次
        self._create_version('梦想是起点。过程很重要。梦想也是终点。')
        comment = self._create_comment(highlighted_text='梦想')

        self.client.force_authenticate(self.consultant)
        response = self.client.post(
            reverse('document-comments-locate', args=[comment.id]), {}, format='json'
        )
        self.assertEqual(response.status_code, 200)
        matches = response.data['matches']
        self.assertEqual(len(matches), 2)
        positions = {(m['start_position'], m['end_position']) for m in matches}
        self.assertEqual(positions, {(0, 2), (12, 14)})
        for m in matches:
            self.assertIn('context', m)

    def test_locate_returns_empty_when_text_gone(self):
        self._create_version('初稿内容。')
        comment = self._create_comment(highlighted_text='梦想')
        self._create_version('完全重写后的内容。')

        self.client.force_authenticate(self.consultant)
        response = self.client.post(
            reverse('document-comments-locate', args=[comment.id]), {}, format='json'
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['matches'], [])

    def test_comment_list_filters_by_status(self):
        self._create_version('我的梦想是改变世界。')
        outdated = self._create_comment(content='即将过期的批注')
        self._create_version('新版本内容，梦想依旧。')
        active = self._create_comment(content='有效批注')

        self.client.force_authenticate(self.consultant)
        url = reverse('document-comments-list')
        response = self.client.get(url, {
            'document_id': self.document.id,
            'status': DocumentComment.STATUS_OUTDATED,
        })
        ids = [c['id'] for c in response.data['results']]
        self.assertIn(outdated.id, ids)
        self.assertNotIn(active.id, ids)

        response = self.client.get(url, {
            'document_id': self.document.id,
            'status': DocumentComment.STATUS_ACTIVE,
        })
        ids = [c['id'] for c in response.data['results']]
        self.assertIn(active.id, ids)
        self.assertNotIn(outdated.id, ids)
