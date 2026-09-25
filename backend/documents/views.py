from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django.db import transaction
from diff_match_patch import diff_match_patch
from .models import Document, DocumentVersion, DocumentComment
from .serializers import (
    DocumentSerializer, DocumentVersionSerializer, DocumentCommentSerializer
)

CONSULTANT_ROLES = ('consultant', 'admin')


class DocumentViewSet(viewsets.ModelViewSet):
    serializer_class = DocumentSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        application_id = self.request.query_params.get('application_id')

        if application_id:
            return Document.objects.filter(application_id=application_id)

        if user.role == 'student':
            return Document.objects.filter(application__student=user)
        elif user.role == 'consultant':
            students = [sp.user for sp in user.students.all()]
            return Document.objects.filter(application__student__in=students)
        return Document.objects.all()


class DocumentVersionViewSet(viewsets.ModelViewSet):
    serializer_class = DocumentVersionSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        document_id = self.request.query_params.get('document_id')
        if document_id:
            return DocumentVersion.objects.filter(document_id=document_id)
        return DocumentVersion.objects.all()

    @transaction.atomic
    def create(self, request, *args, **kwargs):
        document_id = request.data.get('document')
        try:
            document = Document.objects.get(id=document_id)
        except Document.DoesNotExist:
            return Response({'error': 'Document not found'}, status=status.HTTP_404_NOT_FOUND)

        previous_version = document.versions.order_by('-version_number').first()

        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        new_version = serializer.save(document=document, created_by=request.user)

        if previous_version:
            dmp = diff_match_patch()
            diffs = dmp.diff_main(previous_version.content, new_version.content)
            dmp.diff_cleanupSemantic(diffs)
            patches = dmp.patch_make(previous_version.content, diffs)
            new_version.diff_from_previous = dmp.patch_toText(patches)
            new_version.save()

            # 每次保存都会生成新版本：此前最新稿上仍未解决的批注全部转为
            # “待处理的旧批注”，作为历史保留在旧版本上，不再作用于最新稿。
            # 顾问看过新稿并把批注重新绑到明确选中的高亮文字后才会重新生效。
            DocumentComment.objects.filter(
                document=document,
                parent__isnull=True,
                status=DocumentComment.STATUS_ACTIVE,
                is_resolved=False,
            ).update(status=DocumentComment.STATUS_PENDING)

        document.current_version = new_version
        document.save()

        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['get'])
    def compare(self, request, pk=None):
        current_version = self.get_object()
        compare_with_id = request.query_params.get('compare_with')

        try:
            compare_version = DocumentVersion.objects.get(id=compare_with_id)
        except DocumentVersion.DoesNotExist:
            return Response({'error': 'Version not found'}, status=status.HTTP_404_NOT_FOUND)

        dmp = diff_match_patch()
        diffs = dmp.diff_main(compare_version.content, current_version.content)
        dmp.diff_cleanupSemantic(diffs)

        return Response({
            'diffs': [{'operation': d[0], 'text': d[1]} for d in diffs],
            'current_version': DocumentVersionSerializer(current_version).data,
            'compare_version': DocumentVersionSerializer(compare_version).data
        })


class DocumentCommentViewSet(viewsets.ModelViewSet):
    serializer_class = DocumentCommentSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        qs = DocumentComment.objects.filter(parent__isnull=True)
        document_id = self.request.query_params.get('document_id')
        if document_id:
            qs = qs.filter(document_id=document_id)
        status_filter = self.request.query_params.get('status')
        if status_filter in (DocumentComment.STATUS_ACTIVE, DocumentComment.STATUS_PENDING):
            qs = qs.filter(status=status_filter)
        return qs

    # 批注是顾问向学生反馈修改意见的工具：只有顾问（及管理员）可新增。
    # 学生可以查看、并可将批注标记为已解决。
    def create(self, request, *args, **kwargs):
        if request.user.role not in CONSULTANT_ROLES:
            return Response({'error': '只有顾问可以添加批注。'},
                            status=status.HTTP_403_FORBIDDEN)
        return super().create(request, *args, **kwargs)

    def _validate_anchor(self, document, version, start, end, highlighted_text):
        """校验顾问明确选中的高亮文字；系统不自动挑选出现位置。"""
        if start is None or end is None or not (highlighted_text or '').strip():
            return '请先在最新稿中明确选中要批注的文字，再提交绑定。'
        if start < 0 or end <= start:
            return '选中的文字区间无效，请重新选择。'
        current_version = document.current_version
        if current_version is None:
            return '文书还没有保存过正文，请先保存一个版本。'
        if version is None or version.pk != current_version.pk:
            return '批注只能绑定到最新稿，请保存当前修改后再重新绑定。'
        if current_version.content[start:end] != highlighted_text:
            return '选中的文字与最新稿内容不一致，请重新在最新稿中选择。'
        return None

    @action(detail=True, methods=['post'])
    def resolve(self, request, pk=None):
        comment = self.get_object()
        comment.is_resolved = True
        comment.save()
        return Response(DocumentCommentSerializer(comment).data)

    @action(detail=True, methods=['post'], url_path='rebind')
    def rebind(self, request, pk=None):
        """顾问看过新稿后，把待处理旧批注重新绑到明确选中的高亮文字。

        同一段文字在新稿中出现多次时，系统不自动选择位置，一律以顾问
        显式选中的 start/end 为准。重新绑定成功后批注恢复生效。
        """
        if request.user.role not in CONSULTANT_ROLES:
            return Response({'error': '只有顾问可以重新绑定批注。'},
                            status=status.HTTP_403_FORBIDDEN)

        comment = self.get_object()

        if comment.is_resolved:
            return Response({'error': '该批注已解决，无需重新绑定。'},
                            status=status.HTTP_400_BAD_REQUEST)

        try:
            start = int(request.data.get('start_position'))
            end = int(request.data.get('end_position'))
        except (TypeError, ValueError):
            return Response({'error': '请先在最新稿中选中文字再绑定。'},
                            status=status.HTTP_400_BAD_REQUEST)
        highlighted_text = request.data.get('highlighted_text', '')

        version_id = request.data.get('version')
        try:
            version = DocumentVersion.objects.get(
                id=version_id, document=comment.document
            )
        except (DocumentVersion.DoesNotExist, TypeError, ValueError):
            version = None

        error = self._validate_anchor(
            comment.document, version, start, end, highlighted_text
        )
        if error:
            return Response({'error': error}, status=status.HTTP_400_BAD_REQUEST)

        comment.version = version
        comment.start_position = start
        comment.end_position = end
        comment.highlighted_text = highlighted_text
        comment.status = DocumentComment.STATUS_ACTIVE
        comment.save()
        return Response(DocumentCommentSerializer(comment).data)
