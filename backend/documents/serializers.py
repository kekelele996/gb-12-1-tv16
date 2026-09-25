from rest_framework import serializers
from .models import Document, DocumentVersion, DocumentComment

class DocumentCommentSerializer(serializers.ModelSerializer):
    author_name = serializers.CharField(source='author.username', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    version_number = serializers.IntegerField(source='version.version_number', read_only=True)
    replies = serializers.SerializerMethodField()

    class Meta:
        model = DocumentComment
        fields = ['id', 'document', 'version', 'version_number', 'author', 'author_name',
                  'content', 'start_position', 'end_position',
                  'highlighted_text', 'status', 'status_display', 'is_resolved', 'parent',
                  'replies', 'created_at', 'updated_at']
        read_only_fields = ['id', 'author', 'status', 'created_at', 'updated_at']

    def get_replies(self, obj):
        if obj.replies.exists():
            return DocumentCommentSerializer(obj.replies.all(), many=True).data
        return []

    def create(self, validated_data):
        validated_data['author'] = self.context['request'].user
        # 新批注默认绑定到文书当前版本，使其对最新稿生效
        if not validated_data.get('version'):
            document = validated_data.get('document')
            if document and document.current_version:
                validated_data['version'] = document.current_version
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
    comments_count = serializers.SerializerMethodField()
    active_comments_count = serializers.SerializerMethodField()
    outdated_comments_count = serializers.SerializerMethodField()
    created_by_name = serializers.CharField(source='created_by.username', read_only=True)

    class Meta:
        model = Document
        fields = ['id', 'application', 'document_type', 'document_type_display',
                  'title', 'description', 'file', 'current_version',
                  'versions_count', 'comments_count',
                  'active_comments_count', 'outdated_comments_count',
                  'created_by', 'created_by_name', 'created_at', 'updated_at']
        read_only_fields = ['id', 'current_version', 'versions_count',
                           'comments_count', 'active_comments_count',
                           'outdated_comments_count',
                           'created_by', 'created_at', 'updated_at']

    def get_versions_count(self, obj):
        return obj.versions.count()

    def get_comments_count(self, obj):
        # 未解决的顶层批注总数（有效 + 待处理）
        return obj.comments.filter(parent__isnull=True).exclude(
            status=DocumentComment.STATUS_RESOLVED
        ).count()

    def get_active_comments_count(self, obj):
        # 最新稿上的有效批注数
        return obj.comments.filter(
            parent__isnull=True,
            status=DocumentComment.STATUS_ACTIVE
        ).count()

    def get_outdated_comments_count(self, obj):
        # 旧稿遗留、等待顾问重新绑定的批注数
        return obj.comments.filter(
            parent__isnull=True,
            status=DocumentComment.STATUS_OUTDATED
        ).count()
    
    def create(self, validated_data):
        validated_data['created_by'] = self.context['request'].user
        return super().create(validated_data)
