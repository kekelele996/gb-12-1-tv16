from django.apps import AppConfig


class MessagingConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'messages'
    # 与 django.contrib.messages 的应用标签冲突，改用独立标签
    label = 'messaging'
    verbose_name = '站内消息'
