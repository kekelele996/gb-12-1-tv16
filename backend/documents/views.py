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

        data = request.data.copy()
        data['created_by'] = request.user.id

        serializer = self.get_serializer(data=data)
        serializer.is_valid(raise_exception=True)

        new_version = serializer.save(created_by=request.user, document=document)

        if previous_version:
            dmp = diff_match_patch()
            diffs = dmp.diff_main(previous_version.content, new_version.content)
            dmp.diff_cleanupSemantic(diffs)
            patches = dmp.patch_make(previous_version.content, diffs)
            new_version.diff_from_previous = dmp.patch_toText(patches)
            new_version.save()

        document.current_version = new_version
        document.save()

        # 每次保存生成新版本后，旧稿上仍生效的批注转为"待处理"历史状态，
        # 不再影响最新稿；顾问重新绑定到新稿后才会再次生效
        active_comments = document.comments.filter(status=DocumentComment.STATUS_ACTIVE)
        outdated_count = active_comments.filter(parent__isnull=True).count()
        active_comments.update(status=DocumentComment.STATUS_OUTDATED)

        response_data = serializer.data
        response_data['outdated_comments_count'] = outdated_count
        return Response(response_data, status=status.HTTP_201_CREATED)
    
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
        queryset = DocumentComment.objects.filter(parent__isnull=True)
        document_id = self.request.query_params.get('document_id')
        if document_id:
            queryset = queryset.filter(document_id=document_id)
        comment_status = self.request.query_params.get('status')
        if comment_status:
            queryset = queryset.filter(status=comment_status)
        return queryset

    @action(detail=True, methods=['post'])
    def resolve(self, request, pk=None):
        comment = self.get_object()
        comment.status = DocumentComment.STATUS_RESOLVED
        comment.save()
        # 同一条批注下的回复一并标记解决
        comment.replies.filter(status=DocumentComment.STATUS_ACTIVE).update(
            status=DocumentComment.STATUS_RESOLVED, is_resolved=True
        )
        return Response(DocumentCommentSerializer(comment).data)

    @action(detail=True, methods=['post'])
    def locate(self, request, pk=None):
        """在最新稿中查找指定文本的所有出现位置。

        同一段文字出现多次时返回全部候选位置（含上下文），
        由顾问自行选定，系统不自动挑选。
        """
        comment = self.get_object()
        document = comment.document
        current_version = document.current_version
        if not current_version:
            return Response(
                {'error': '文书还没有任何版本，无法定位'},
                status=status.HTTP_400_BAD_REQUEST
            )

        text = request.data.get('text') or comment.highlighted_text
        if not text:
            return Response(
                {'error': '缺少要查找的文本'},
                status=status.HTTP_400_BAD_REQUEST
            )

        content = current_version.content or ''
        matches = []
        start = content.find(text)
        while start != -1:
            end = start + len(text)
            matches.append({
                'start_position': start,
                'end_position': end,
                'context': content[max(0, start - 30):min(len(content), end + 30)],
            })
            start = content.find(text, end)

        return Response({
            'text': text,
            'version_id': current_version.id,
            'version_number': current_version.version_number,
            'matches': matches,
        })

    @action(detail=True, methods=['post'])
    @transaction.atomic
    def rebind(self, request, pk=None):
        """把旧稿批注重新绑定到最新稿中明确选中的高亮文字上。

        必须显式给出 start_position / end_position / highlighted_text，
        且该区间文本须与最新稿完全一致，批注才重新生效。
        """
        if request.user.role not in ('consultant', 'admin'):
            return Response(
                {'error': '只有顾问可以重新绑定批注'},
                status=status.HTTP_403_FORBIDDEN
            )

        comment = self.get_object()
        if comment.parent_id:
            return Response(
                {'error': '回复不能单独重新绑定，请操作对应的批注'},
                status=status.HTTP_400_BAD_REQUEST
            )
        if comment.status == DocumentComment.STATUS_RESOLVED:
            return Response(
                {'error': '已解决的批注无需重新绑定'},
                status=status.HTTP_400_BAD_REQUEST
            )

        document = comment.document
        current_version = document.current_version
        if not current_version:
            return Response(
                {'error': '文书还没有任何版本，无法绑定'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            start_position = int(request.data.get('start_position'))
            end_position = int(request.data.get('end_position'))
        except (TypeError, ValueError):
            return Response(
                {'error': '必须明确指定绑定的起止位置'},
                status=status.HTTP_400_BAD_REQUEST
            )
        highlighted_text = request.data.get('highlighted_text') or ''

        content = current_version.content or ''
        if not (0 <= start_position < end_position <= len(content)):
            return Response(
                {'error': '绑定位置超出最新稿范围'},
                status=status.HTTP_400_BAD_REQUEST
            )
        if content[start_position:end_position] != highlighted_text:
            return Response(
                {'error': '指定区间的文字与最新稿不一致，请重新选择'},
                status=status.HTTP_400_BAD_REQUEST
            )

        comment.version = current_version
        comment.start_position = start_position
        comment.end_position = end_position
        comment.highlighted_text = highlighted_text
        comment.status = DocumentComment.STATUS_ACTIVE
        comment.save()
        # 该批注下的回复随批注一起重新生效
        comment.replies.filter(status=DocumentComment.STATUS_OUTDATED).update(
            status=DocumentComment.STATUS_ACTIVE, is_resolved=False
        )

        return Response(DocumentCommentSerializer(comment).data)
