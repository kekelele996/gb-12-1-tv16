from rest_framework import serializers
from .models import Document, DocumentVersion, DocumentComment

class DocumentCommentSerializer(serializers.ModelSerializer):
    author_name = serializers.CharField(source='author.username', read_only=True)
    version_number = serializers.IntegerField(
        source='version.version_number', read_only=True, allow_null=True
    )
    replies = serializers.SerializerMethodField()

    class Meta:
        model = DocumentComment
        fields = ['id', 'document', 'version', 'version_number', 'author', 'author_name',
                  'content', 'start_position', 'end_position',
                  'highlighted_text', 'status', 'is_resolved', 'parent',
                  'replies', 'created_at', 'updated_at']
        read_only_fields = ['id', 'author', 'status', 'created_at', 'updated_at']

    def get_replies(self, obj):
        if obj.replies.exists():
            return DocumentCommentSerializer(obj.replies.all(), many=True).data
        return []

    def validate(self, attrs):
        # 仅对顶级批注校验锚点；回复跟随父批注，不需要选中文字
        if attrs.get('parent') is None:
            start = attrs.get('start_position')
            end = attrs.get('end_position')
            highlighted = (attrs.get('highlighted_text') or '').strip()
            if start is None or end is None or not highlighted:
                raise serializers.ValidationError({
                    'highlighted_text': '请先在文书正文中明确选中要批注的文字，再提交批注。'
                })
            if start < 0 or end <= start:
                raise serializers.ValidationError({
                    'start_position': '选中的文字区间无效。'
                })

            # 锚定的必须是该文书当前（最新）版本，并按区间核对选中文字。
            # 顾问必须自己明确选中；即使同一段文字出现多次，系统也不代为选择。
            document = attrs.get('document')
            version = attrs.get('version')
            current_version = document.current_version if document else None
            if current_version is None:
                raise serializers.ValidationError({
                    'version': '文书还没有保存过正文，请先保存一个版本。'
                })
            if version is None or version.pk != current_version.pk:
                raise serializers.ValidationError({
                    'version': '批注只能绑定到最新稿；旧稿上的批注请重新选中最新稿文字。'
                })
            actual = current_version.content[start:end]
            if actual != attrs.get('highlighted_text'):
                raise serializers.ValidationError({
                    'highlighted_text': '选中的文字与最新稿内容不一致，请重新在最新稿中选择。'
                })
        return attrs

    def create(self, validated_data):
        validated_data['author'] = self.context['request'].user
        # 新建的顶级批注已显式绑定到最新稿选中文字，立即生效
        if validated_data.get('parent') is None:
            validated_data['status'] = DocumentComment.STATUS_ACTIVE
        return super().create(validated_data)

class DocumentVersionSerializer(serializers.ModelSerializer):
    created_by_name = serializers.CharField(source='created_by.username', read_only=True)

    class Meta:
        model = DocumentVersion
        fields = ['id', 'document', 'version_number', 'content', 'file',
                  'word_count', 'created_by', 'created_by_name',
                  'change_note', 'diff_from_previous', 'created_at']
        read_only_fields = ['id', 'document', 'version_number',
                           'word_count', 'created_by', 'created_at']

class DocumentSerializer(serializers.ModelSerializer):
    document_type_display = serializers.CharField(source='get_document_type_display', read_only=True)
    current_version = DocumentVersionSerializer(read_only=True)
    versions_count = serializers.SerializerMethodField()
    active_comments_count = serializers.SerializerMethodField()
    pending_comments_count = serializers.SerializerMethodField()
    # 兼容旧字段：未解决批注总数（最新稿有效 + 待处理旧批注）
    comments_count = serializers.SerializerMethodField()
    created_by_name = serializers.CharField(source='created_by.username', read_only=True)

    class Meta:
        model = Document
        fields = ['id', 'application', 'document_type', 'document_type_display',
                  'title', 'description', 'file', 'current_version',
                  'versions_count', 'comments_count',
                  'active_comments_count', 'pending_comments_count',
                  'created_by', 'created_by_name', 'created_at', 'updated_at']
        read_only_fields = ['id', 'current_version', 'versions_count',
                           'comments_count', 'active_comments_count',
                           'pending_comments_count',
                           'created_by', 'created_at', 'updated_at']

    def get_versions_count(self, obj):
        return obj.versions.count()

    def _unresolved_top_level(self, obj):
        return obj.comments.filter(
            parent__isnull=True, is_resolved=False
        )

    def get_active_comments_count(self, obj):
        return self._unresolved_top_level(obj).filter(
            status=DocumentComment.STATUS_ACTIVE
        ).count()

    def get_pending_comments_count(self, obj):
        return self._unresolved_top_level(obj).filter(
            status=DocumentComment.STATUS_PENDING
        ).count()

    def get_comments_count(self, obj):
        return self._unresolved_top_level(obj).count()

    def create(self, validated_data):
        validated_data['created_by'] = self.context['request'].user
        return super().create(validated_data)
