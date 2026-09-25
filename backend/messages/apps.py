from django.apps import AppConfig


class MessagesConfig(AppConfig):
    # 避免与 django.contrib.messages 的默认标签冲突
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'messages'
    label = 'direct_messages'
