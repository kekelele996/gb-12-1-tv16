import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Table,
  Card,
  Button,
  Modal,
  Form,
  Select,
  Input,
  Tag,
  Space,
  Typography,
  message,
  Tabs,
  List,
  Avatar,
  Tooltip,
  Alert,
  Empty,
  Badge,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  FileTextOutlined,
  HistoryOutlined,
  MessageOutlined,
  CheckCircleOutlined,
  AimOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import { documentAPI, applicationAPI } from '../api';
import { useAuthStore } from '../store/useAuthStore';
import {
  Document,
  DocumentVersion,
  DocumentComment,
  ApplicationProject,
} from '../types';

const { Title, Text, Paragraph } = Typography;
const { Option } = Select;
const { TextArea } = Input;

const documentTypeMap: { [key: string]: string } = {
  ps: '个人陈述 (PS)',
  rl: '推荐信 (RL)',
  cv: '简历 (CV)',
  essay: 'Essay',
  other: '其他',
};

interface TextSelection {
  start: number;
  end: number;
  text: string;
  occurrences: number;
}

const Documents: React.FC = () => {
  const { user } = useAuthStore();
  const isConsultant = user?.role === 'consultant' || user?.role === 'admin';

  const [loading, setLoading] = useState(true);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [applications, setApplications] = useState<ApplicationProject[]>([]);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [comments, setComments] = useState<DocumentComment[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [editorVisible, setEditorVisible] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [activeTab, setActiveTab] = useState('editor');
  const [editorContent, setEditorContent] = useState('');
  // 已保存的最新稿内容，作为选中高亮的基准（未保存修改不允许绑定批注）
  const [savedContent, setSavedContent] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [newComment, setNewComment] = useState('');
  const [rebindTarget, setRebindTarget] = useState<DocumentComment | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textAreaRef = useRef<any>(null);

  const isDirty = editorContent !== savedContent;

  const activeComments = useMemo(
    () => comments.filter((c) => !c.is_resolved && c.status === 'active'),
    [comments]
  );
  const pendingComments = useMemo(
    () => comments.filter((c) => !c.is_resolved && c.status === 'pending'),
    [comments]
  );

  useEffect(() => {
    fetchDocuments();
    fetchApplications();
  }, []);

  const fetchDocuments = async () => {
    try {
      setLoading(true);
      const response = await documentAPI.getDocuments();
      setDocuments(response.data.results || response.data);
    } catch (error) {
      console.error('获取文书列表失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchApplications = async () => {
    try {
      const response = await applicationAPI.getApplications();
      setApplications(response.data.results || response.data);
    } catch (error) {
      console.error('获取申请列表失败:', error);
    }
  };

  const refreshDetail = async (documentId: number) => {
    try {
      const [docRes, versionsRes, commentsRes] = await Promise.all([
        documentAPI.getDocument(documentId),
        documentAPI.getVersions({ document_id: documentId }),
        documentAPI.getComments({ document_id: documentId }),
      ]);
      const doc: Document = docRes.data;
      setSelectedDocument(doc);
      setDocuments((prev) => prev.map((d) => (d.id === doc.id ? doc : d)));
      setVersions(versionsRes.data.results || versionsRes.data);
      setComments(commentsRes.data.results || commentsRes.data);
      const latest = doc.current_version?.content ?? '';
      setSavedContent(latest);
      setEditorContent(latest);
      return doc;
    } catch (error) {
      console.error('获取文书详情失败:', error);
    }
  };

  const handleCreate = () => {
    form.resetFields();
    setModalVisible(true);
  };

  const handleSubmit = async (values: any) => {
    try {
      await documentAPI.createDocument(values);
      message.success('文书创建成功');
      setModalVisible(false);
      fetchDocuments();
    } catch (error) {
      message.error('创建失败');
    }
  };

  const handleEdit = async (document: Document) => {
    setSelectedDocument(document);
    setSelection(null);
    setRebindTarget(null);
    setNewComment('');
    setChangeNote('');
    setActiveTab('editor');
    setEditorVisible(true);
    await refreshDetail(document.id);
  };

  // 读取 textarea 中当前明确选中的文字。系统不会自动挑选文字出现的位置。
  const captureSelection = (): TextSelection | null => {
    const el: HTMLTextAreaElement | undefined =
      textAreaRef.current?.resizableTextArea?.textArea;
    if (!el) return null;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (end <= start) return null;
    const text = savedContent.slice(start, end);
    if (!text.trim()) return null;
    let occurrences = 0;
    let idx = savedContent.indexOf(text);
    while (idx !== -1) {
      occurrences += 1;
      idx = savedContent.indexOf(text, idx + 1);
    }
    return { start, end, text, occurrences };
  };

  const handleSelect = () => {
    setSelection(captureSelection());
  };

  // 每次保存都生成新版本；保存成功后，最新稿上的旧批注自动转入“待处理”。
  const handleSaveVersion = async () => {
    if (!selectedDocument) return;
    try {
      setSubmitting(true);
      await documentAPI.createVersion({
        document: selectedDocument.id,
        content: editorContent,
        change_note: changeNote,
      });
      message.success('新版本已保存，旧批注已归档为待处理，等待顾问重新绑定');
      setChangeNote('');
      setSelection(null);
      setRebindTarget(null);
      await refreshDetail(selectedDocument.id);
      await fetchDocuments();
    } catch (error: any) {
      message.error(error.response?.data?.detail || '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddComment = async () => {
    if (!selectedDocument || !selection || !newComment.trim()) return;
    if (isDirty) {
      message.warning('当前有未保存修改，请先保存新版本，再在最新稿上选中文字添加批注');
      return;
    }
    const currentVersionId = selectedDocument.current_version?.id;
    if (!currentVersionId) {
      message.warning('请先保存至少一个版本');
      return;
    }
    try {
      setSubmitting(true);
      await documentAPI.createComment({
        document: selectedDocument.id,
        version: currentVersionId,
        content: newComment.trim(),
        start_position: selection.start,
        end_position: selection.end,
        highlighted_text: selection.text,
      });
      message.success('批注已添加并在最新稿生效');
      setNewComment('');
      setSelection(null);
      await refreshDetail(selectedDocument.id);
    } catch (error: any) {
      message.error(error.response?.data?.highlighted_text?.[0] || '添加批注失败');
    } finally {
      setSubmitting(false);
    }
  };

  // 顾问在列表里对某条待处理旧批注发起重新绑定：先去最新稿明确选中文字。
  const startRebind = (comment: DocumentComment) => {
    if (isDirty) {
      message.warning('当前有未保存修改，请先保存新版本，再重新绑定批注');
      return;
    }
    setRebindTarget(comment);
    setSelection(null);
    setActiveTab('editor');
    message.info(
      `请在最新稿中为批注「${comment.content.slice(0, 20)}…」选中文字。` +
        '相同文字出现多处时，请点选你要的那一处'
    );
  };

  // 在编辑器页确认绑定当前选中
  const confirmRebind = async () => {
    if (!selectedDocument || !rebindTarget || !selection) return;
    const currentVersionId = selectedDocument.current_version?.id;
    if (!currentVersionId) return;
    try {
      setSubmitting(true);
      await documentAPI.rebindComment(rebindTarget.id, {
        version: currentVersionId,
        start_position: selection.start,
        end_position: selection.end,
        highlighted_text: selection.text,
      });
      message.success('批注已重新绑定到选中文字，并在最新稿重新生效');
      setRebindTarget(null);
      setSelection(null);
      await refreshDetail(selectedDocument.id);
    } catch (error: any) {
      message.error(error.response?.data?.error || '重新绑定失败');
    } finally {
      setSubmitting(false);
    }
  };

  const cancelRebind = () => {
    setRebindTarget(null);
    setSelection(null);
  };

  const handleResolveComment = async (commentId: number) => {
    try {
      await documentAPI.resolveComment(commentId);
      message.success('已标记为已解决');
      if (selectedDocument) {
        await refreshDetail(selectedDocument.id);
      }
    } catch (error) {
      message.error('操作失败');
    }
  };

  const columns = [
    {
      title: '文书类型',
      dataIndex: 'document_type',
      key: 'document_type',
      width: 150,
      render: (type: string) => <Tag color="blue">{documentTypeMap[type]}</Tag>,
    },
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
    },
    {
      title: '所属申请',
      key: 'application',
      width: 200,
      render: (_: any, record: Document) => {
        const app = applications.find((a) => a.id === record.application);
        return app ? `${app.university_name} - ${app.program_name}` : '-';
      },
    },
    {
      title: '版本数',
      dataIndex: 'versions_count',
      key: 'versions_count',
      width: 90,
    },
    {
      title: '最新稿有效批注',
      dataIndex: 'active_comments_count',
      key: 'active_comments_count',
      width: 130,
      render: (count: number) =>
        count > 0 ? <Tag color="red">{count} 条</Tag> : <Tag color="green">0 条</Tag>,
    },
    {
      title: '待处理旧批注',
      dataIndex: 'pending_comments_count',
      key: 'pending_comments_count',
      width: 130,
      render: (count: number) =>
        count > 0 ? <Tag color="orange">{count} 条</Tag> : <Tag>0 条</Tag>,
    },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 180,
      render: (date: string) => new Date(date).toLocaleString(),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_: any, record: Document) => (
        <Space>
          <Button
            type="link"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            编辑
          </Button>
          <Button
            type="link"
            danger
            icon={<DeleteOutlined />}
            onClick={() => {
              Modal.confirm({
                title: '确认删除',
                content: '确定要删除这个文书吗？',
                onOk: async () => {
                  try {
                    await documentAPI.deleteDocument(record.id);
                    message.success('删除成功');
                    fetchDocuments();
                  } catch (error) {
                    message.error('删除失败');
                  }
                },
              });
            }}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const renderCommentActions = (comment: DocumentComment, pending: boolean) => [
    pending && isConsultant && !comment.is_resolved && (
      <Button
        key="rebind"
        type="link"
        icon={<AimOutlined />}
        onClick={() => startRebind(comment)}
      >
        重新绑定到最新稿
      </Button>
    ),
    !comment.is_resolved && (
      <Tooltip key="resolve" title="标记为已解决">
        <Button
          type="link"
          icon={<CheckCircleOutlined />}
          onClick={() => handleResolveComment(comment.id)}
        >
          解决
        </Button>
      </Tooltip>
    ),
  ];

  const renderCommentList = (list: DocumentComment[], pending: boolean) => {
    if (list.length === 0) {
      return <Empty description={pending ? '没有待处理的旧批注' : '最新稿暂无有效批注'} />;
    }
    return (
      <List
        dataSource={list}
        renderItem={(comment) => (
          <List.Item key={comment.id} actions={renderCommentActions(comment, pending)}>
            <List.Item.Meta
              avatar={<Avatar>{comment.author_name?.[0]}</Avatar>}
              title={
                <Space wrap size={8}>
                  <span>{comment.author_name || '匿名用户'}</span>
                  {pending ? (
                    <Tag color="orange" icon={<ExclamationCircleOutlined />}>
                      待处理旧批注
                    </Tag>
                  ) : (
                    <Tag color="red">最新稿有效</Tag>
                  )}
                  {comment.version_number != null && (
                    <Tag>{pending ? '来自' : '绑定'} v{comment.version_number}</Tag>
                  )}
                </Space>
              }
              description={
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Paragraph
                    style={{ margin: 0 }}
                    ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
                  >
                    <Text mark>“{comment.highlighted_text || '（无高亮文字）'}”</Text>
                  </Paragraph>
                  <span>{comment.content}</span>
                  {pending && (
                    <Text type="warning" style={{ fontSize: 12 }}>
                      该批注来自旧版本，不会影响最新稿；请顾问在最新稿明确选中文字后重新绑定。
                    </Text>
                  )}
                  <span style={{ color: '#999', fontSize: 12 }}>
                    {new Date(comment.created_at).toLocaleString()}
                  </span>
                </Space>
              }
            />
          </List.Item>
        )}
      />
    );
  };

  const selectionHint = selection
    ? selection.occurrences > 1
      ? `已选中第 ${selection.start}–${selection.end} 个字符；这段文字在最新稿中出现 ${selection.occurrences} 次，系统不会自动挑选，当前以你明确选中的这一处为准。`
      : `已选中第 ${selection.start}–${selection.end} 个字符。`
    : null;

  const editorTab = {
    key: 'editor',
    label: '编辑器',
    icon: <FileTextOutlined />,
    children: (
      <div>
        {pendingComments.length > 0 && (
          <Alert
            style={{ marginBottom: 12 }}
            type="warning"
            showIcon
            icon={<ExclamationCircleOutlined />}
            message={`有 ${pendingComments.length} 条旧批注等待顾问重新绑定`}
            description="旧批注保留在历史版本中，不会影响最新稿；请到「批注」标签页处理。"
            action={
              <Button size="small" onClick={() => setActiveTab('comments')}>
                去处理
              </Button>
            }
          />
        )}

        {rebindTarget && (
          <Alert
            style={{ marginBottom: 12 }}
            type="info"
            showIcon
            icon={<AimOutlined />}
            message="重新绑定批注模式"
            description={
              <Space direction="vertical" size={4}>
                <span>
                  请在下方最新稿中选中要绑定的文字（相同文字出现多处时，请点选目标的那一处，系统不会自动选择）。
                </span>
                <Space>
                  <Button
                    type="primary"
                    size="small"
                    disabled={!selection || isDirty}
                    loading={submitting}
                    onClick={confirmRebind}
                  >
                    绑定到当前选中
                  </Button>
                  <Button size="small" onClick={cancelRebind}>
                    取消
                  </Button>
                </Space>
              </Space>
            }
          />
        )}

        {isDirty && !rebindTarget && (
          <Alert
            style={{ marginBottom: 12 }}
            type="warning"
            showIcon
            message="当前修改尚未保存"
            description="请先保存为新版本；保存后上一版未解决批注会转为待处理旧批注，不再影响最新稿。"
          />
        )}

        <TextArea
          ref={textAreaRef}
          value={editorContent}
          onChange={(e) => setEditorContent(e.target.value)}
          onSelect={handleSelect}
          onMouseUp={handleSelect}
          onKeyUp={handleSelect}
          rows={15}
          placeholder="在此输入文书内容...每次保存都会生成新版本"
          className="document-editor"
          style={{ marginBottom: 12 }}
        />

        {selection && selectionHint && (
          <Alert
            style={{ marginBottom: 12 }}
            type="success"
            showIcon
            message={selectionHint}
            description={
              isDirty ? (
                <Text type="warning">选区基于已保存的最新稿，内容已被修改，请先保存后再选中。</Text>
              ) : undefined
            }
          />
        )}

        {isConsultant && !rebindTarget && (
          <Card
            size="small"
            style={{ marginBottom: 16 }}
            title={<><AimOutlined /> 对选中文字添加批注（最新稿）</>}
          >
            <TextArea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              rows={2}
              placeholder={
                selection
                  ? '输入对高亮文字的修改意见...'
                  : '请先用鼠标在上方最新稿正文中选中文字，再写批注'
              }
            />
            <Button
              type="primary"
              style={{ marginTop: 8 }}
              loading={submitting}
              disabled={!selection || !newComment.trim() || isDirty}
              onClick={handleAddComment}
            >
              提交批注并绑定到选中文字
            </Button>
          </Card>
        )}

        <Input
          placeholder="版本修改说明（选填）"
          value={changeNote}
          onChange={(e) => setChangeNote(e.target.value)}
          style={{ marginBottom: 16 }}
        />
        <Button type="primary" onClick={handleSaveVersion} loading={submitting}>
          保存为新版本
        </Button>
      </div>
    ),
  };

  const historyTab = {
    key: 'history',
    label: `版本历史 (${versions.length})`,
    icon: <HistoryOutlined />,
    children: (
      <List
        itemLayout="vertical"
        dataSource={versions}
        renderItem={(version) => (
          <List.Item key={version.id}>
            <List.Item.Meta
              title={
                <Space>
                  版本 {version.version_number}
                  {selectedDocument?.current_version?.id === version.id && (
                    <Tag color="blue">最新稿</Tag>
                  )}
                </Space>
              }
              description={`
                字数: ${version.word_count} |
                修改人: ${version.created_by_name || '未知'} |
                ${new Date(version.created_at).toLocaleString()}
              `}
            />
            {version.change_note && (
              <p style={{ color: '#666', fontStyle: 'italic' }}>
                修改说明: {version.change_note}
              </p>
            )}
          </List.Item>
        )}
      />
    ),
  };

  const commentsTab = {
    key: 'comments',
    label: (
      <Badge size="small" count={activeComments.length + pendingComments.length} offset={[10, -2]}>
        <span>
          <MessageOutlined /> 批注
        </span>
      </Badge>
    ),
    children: (
      <div>
        <Space style={{ marginBottom: 16 }} size={24}>
          <Text strong>
            <Tag color="red">最新稿有效批注</Tag>
            {activeComments.length} 条
          </Text>
          <Text strong>
            <Tag color="orange">待处理旧批注</Tag>
            {pendingComments.length} 条
          </Text>
        </Space>

        <Card
          size="small"
          style={{ marginBottom: 16 }}
          title={
            <Space>
              <Tag color="red">最新稿有效批注</Tag>
              <span>{activeComments.length} 条</span>
            </Space>
          }
        >
          {renderCommentList(activeComments, false)}
        </Card>

        <Card
          size="small"
          title={
            <Space>
              <Tag color="orange" icon={<ExclamationCircleOutlined />}>
                待处理旧批注
              </Tag>
              <span>{pendingComments.length} 条</span>
            </Space>
          }
          extra={
            pendingComments.length > 0 ? (
              <Text type="secondary">顾问重新选中最新稿文字后才会恢复生效</Text>
            ) : null
          }
        >
          {renderCommentList(pendingComments, true)}
        </Card>
      </div>
    ),
  };

  return (
    <div>
      <Title level={2} className="page-header">
        文书管理
      </Title>

      <Card>
        <div style={{ marginBottom: 16, textAlign: 'right' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            新建文书
          </Button>
        </div>

        <Table
          columns={columns as any}
          dataSource={documents}
          rowKey="id"
          loading={loading}
          pagination={{
            showSizeChanger: true,
            showQuickJumper: true,
            pageSizeOptions: ['10', '20', '50'],
            defaultPageSize: 10,
          }}
        />
      </Card>

      <Modal
        title="新建文书"
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item
            name="application"
            label="所属申请项目"
            rules={[{ required: true, message: '请选择申请项目' }]}
          >
            <Select placeholder="请选择">
              {applications.map((app) => (
                <Option key={app.id} value={app.id}>
                  {app.university_name} - {app.program_name}
                </Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            name="document_type"
            label="文书类型"
            rules={[{ required: true, message: '请选择文书类型' }]}
          >
            <Select placeholder="请选择">
              <Option value="ps">个人陈述 (PS)</Option>
              <Option value="rl">推荐信 (RL)</Option>
              <Option value="cv">简历 (CV)</Option>
              <Option value="essay">Essay</Option>
              <Option value="other">其他</Option>
            </Select>
          </Form.Item>

          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: '请输入标题' }]}
          >
            <Input placeholder="请输入文书标题" />
          </Form.Item>

          <Form.Item name="description" label="描述">
            <TextArea rows={3} placeholder="文书描述（选填）" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`编辑: ${selectedDocument?.title}`}
        open={editorVisible}
        onCancel={() => setEditorVisible(false)}
        width={900}
        footer={null}
      >
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[editorTab, historyTab, commentsTab]}
        />
      </Modal>
    </div>
  );
};

export default Documents;
