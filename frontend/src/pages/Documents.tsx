import React, { useState, useEffect, useRef } from 'react';
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
  Divider,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  FileTextOutlined,
  HistoryOutlined,
  MessageOutlined,
  CheckCircleOutlined,
  LinkOutlined,
  AimOutlined,
} from '@ant-design/icons';
import { documentAPI, applicationAPI } from '../api';
import { useAuthStore } from '../store/useAuthStore';
import {
  Document,
  DocumentVersion,
  DocumentComment,
  CommentLocateMatch,
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

interface SelectionRange {
  start: number;
  end: number;
  text: string;
}

const Documents: React.FC = () => {
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
  const [changeNote, setChangeNote] = useState('');
  const [newComment, setNewComment] = useState('');
  // 重新绑定相关状态
  const [rebindTarget, setRebindTarget] = useState<DocumentComment | null>(null);
  const [rebindSelection, setRebindSelection] = useState<SelectionRange | null>(null);
  const [locateMatches, setLocateMatches] = useState<CommentLocateMatch[] | null>(null);
  const [locateText, setLocateText] = useState('');
  const [locateLoading, setLocateLoading] = useState(false);
  const [rebindLoading, setRebindLoading] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const [form] = Form.useForm();
  const { user } = useAuthStore();

  const storedUser = (() => {
    try {
      return JSON.parse(localStorage.getItem('user') || 'null');
    } catch {
      return null;
    }
  })();
  const currentRole = (user || storedUser)?.role;
  const canRebind = currentRole === 'consultant' || currentRole === 'admin';

  // 版本列表按版本号倒序，第一条即最新稿
  const latestVersion = versions[0] || null;
  const activeComments = comments.filter((c) => c.status === 'active');
  const outdatedComments = comments.filter((c) => c.status === 'outdated');
  const resolvedComments = comments.filter((c) => c.status === 'resolved');

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

  const refreshComments = async () => {
    if (!selectedDocument) return;
    const response = await documentAPI.getComments({ document_id: selectedDocument.id });
    setComments(response.data.results || response.data);
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

    if (document.current_version) {
      setEditorContent(document.current_version.content);
    } else {
      setEditorContent('');
    }

    try {
      const [versionsRes, commentsRes] = await Promise.all([
        documentAPI.getVersions({ document_id: document.id }),
        documentAPI.getComments({ document_id: document.id }),
      ]);
      setVersions(versionsRes.data.results || versionsRes.data);
      setComments(commentsRes.data.results || commentsRes.data);
    } catch (error) {
      console.error('获取文书详情失败:', error);
    }

    setEditorVisible(true);
  };

  const handleSaveVersion = async () => {
    if (!selectedDocument) return;

    try {
      const response = await documentAPI.createVersion({
        document: selectedDocument.id,
        content: editorContent,
        change_note: changeNote,
      });
      const outdatedCount = response.data?.outdated_comments_count || 0;
      message.success(
        outdatedCount > 0
          ? `新版本已保存，${outdatedCount} 条旧批注已转为待处理`
          : '版本保存成功'
      );
      setChangeNote('');
      fetchDocuments();

      const versionsRes = await documentAPI.getVersions({ document_id: selectedDocument.id });
      setVersions(versionsRes.data.results || versionsRes.data);
      // 旧批注状态已变化，刷新批注列表
      refreshComments();
    } catch (error) {
      message.error('保存失败');
    }
  };

  const handleAddComment = async () => {
    if (!selectedDocument || !newComment.trim()) return;

    try {
      await documentAPI.createComment({
        document: selectedDocument.id,
        content: newComment.trim(),
      });
      message.success('评论添加成功');
      setNewComment('');
      refreshComments();
      fetchDocuments();
    } catch (error) {
      message.error('添加评论失败');
    }
  };

  const handleResolveComment = async (commentId: number) => {
    try {
      await documentAPI.resolveComment(commentId);
      message.success('已标记为已解决');
      refreshComments();
      fetchDocuments();
    } catch (error) {
      message.error('操作失败');
    }
  };

  const openRebindModal = (comment: DocumentComment) => {
    setRebindTarget(comment);
    setRebindSelection(null);
    setLocateMatches(null);
    setLocateText('');
  };

  const closeRebindModal = () => {
    setRebindTarget(null);
    setRebindSelection(null);
    setLocateMatches(null);
    setLocateText('');
  };

  // 顾问在最新稿预览中手动选中文字
  const handlePreviewMouseUp = () => {
    const container = previewRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;

    const preRange = document.createRange();
    preRange.selectNodeContents(container);
    preRange.setEnd(range.startContainer, range.startOffset);
    const start = preRange.toString().length;
    const text = range.toString();
    if (!text.trim()) {
      setRebindSelection(null);
      return;
    }
    setRebindSelection({ start, end: start + text.length, text });
    setLocateMatches(null);
  };

  // 按批注原高亮文本在最新稿中查找所有出现位置，由顾问选定
  const handleLocate = async () => {
    if (!rebindTarget) return;
    setLocateLoading(true);
    try {
      const response = await documentAPI.locateComment(rebindTarget.id);
      setLocateText(response.data.text);
      setLocateMatches(response.data.matches);
      setRebindSelection(null);
    } catch (error) {
      message.error('查找失败');
    } finally {
      setLocateLoading(false);
    }
  };

  const submitRebind = async (payload: {
    start_position: number;
    end_position: number;
    highlighted_text: string;
  }) => {
    if (!rebindTarget) return;
    setRebindLoading(true);
    try {
      await documentAPI.rebindComment(rebindTarget.id, payload);
      message.success('批注已重新绑定到最新稿并生效');
      closeRebindModal();
      refreshComments();
      fetchDocuments();
    } catch (error: any) {
      message.error(error?.response?.data?.error || '绑定失败，请重新选择');
    } finally {
      setRebindLoading(false);
    }
  };

  const columns = [
    {
      title: '文书类型',
      dataIndex: 'document_type',
      key: 'document_type',
      width: 150,
      render: (type: string) => (
        <Tag color="blue">{documentTypeMap[type]}</Tag>
      ),
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
      title: '有效批注',
      dataIndex: 'active_comments_count',
      key: 'active_comments_count',
      width: 100,
      render: (count: number) => (
        count > 0 ? <Tag color="blue">{count} 条</Tag> : <Tag color="green">无</Tag>
      ),
    },
    {
      title: '待处理旧批注',
      dataIndex: 'outdated_comments_count',
      key: 'outdated_comments_count',
      width: 130,
      render: (count: number) => (
        count > 0 ? <Tag color="orange">{count} 条</Tag> : <Tag color="green">无</Tag>
      ),
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

  const renderCommentItem = (
    comment: DocumentComment,
    actions: React.ReactNode[],
    extra?: React.ReactNode
  ) => (
    <List.Item key={comment.id} actions={actions}>
      <List.Item.Meta
        avatar={<Avatar>{comment.author_name?.[0]}</Avatar>}
        title={
          <Space>
            <span>{comment.author_name || '匿名用户'}</span>
            {comment.version_number != null && (
              <Tag>{`v${comment.version_number}`}</Tag>
            )}
            {extra}
          </Space>
        }
        description={
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {comment.highlighted_text && (
              <span>
                引用文字：<Text mark>{comment.highlighted_text}</Text>
              </span>
            )}
            <span>{comment.content}</span>
            <span style={{ color: '#999', fontSize: 12 }}>
              {new Date(comment.created_at).toLocaleString()}
            </span>
          </Space>
        }
      />
    </List.Item>
  );

  const editorTabs = [
    {
      key: 'editor',
      label: '编辑器',
      icon: <FileTextOutlined />,
      children: (
        <div>
          <TextArea
            value={editorContent}
            onChange={(e) => setEditorContent(e.target.value)}
            rows={15}
            placeholder="在此输入文书内容..."
            className="document-editor"
            style={{ marginBottom: 16 }}
          />
          <Input
            placeholder="版本修改说明（选填）"
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value)}
            style={{ marginBottom: 16 }}
          />
          <Button type="primary" onClick={handleSaveVersion}>
            保存版本
          </Button>
        </div>
      ),
    },
    {
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
                title={`版本 ${version.version_number}`}
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
    },
    {
      key: 'comments',
      label: `批注 (有效 ${activeComments.length} / 待处理 ${outdatedComments.length})`,
      icon: <MessageOutlined />,
      children: (
        <div>
          <Space style={{ marginBottom: 16 }} wrap>
            <Tag color="blue">最新稿有效批注 {activeComments.length} 条</Tag>
            <Tag color="orange">待处理旧批注 {outdatedComments.length} 条</Tag>
            <Tag>已解决 {resolvedComments.length} 条</Tag>
          </Space>

          <div style={{ marginBottom: 16 }}>
            <TextArea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              rows={3}
              placeholder="添加评论或批注（将绑定到最新稿）..."
            />
            <Button
              type="primary"
              onClick={handleAddComment}
              style={{ marginTop: 8 }}
              disabled={!newComment.trim()}
            >
              提交评论
            </Button>
          </div>

          <Divider orientation="left" orientationMargin={0}>
            最新稿有效批注 ({activeComments.length})
          </Divider>
          <List
            dataSource={activeComments}
            locale={{ emptyText: '最新稿暂无有效批注' }}
            renderItem={(comment) =>
              renderCommentItem(comment, [
                <Tooltip title="标记为已解决" key="resolve">
                  <Button
                    type="link"
                    icon={<CheckCircleOutlined />}
                    onClick={() => handleResolveComment(comment.id)}
                  >
                    解决
                  </Button>
                </Tooltip>,
              ])
            }
          />

          <Divider orientation="left" orientationMargin={0}>
            待处理旧批注 ({outdatedComments.length})
          </Divider>
          {outdatedComments.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="以下批注来自旧版本，暂不对最新稿生效。顾问看过新稿后，可将批注重新绑定到选中的文字上使其重新生效。"
            />
          )}
          <List
            dataSource={outdatedComments}
            locale={{ emptyText: '没有待处理的旧批注' }}
            renderItem={(comment) =>
              renderCommentItem(
                comment,
                canRebind
                  ? [
                      <Tooltip title="在最新稿中选中文字后重新绑定" key="rebind">
                        <Button
                          type="link"
                          icon={<LinkOutlined />}
                          onClick={() => openRebindModal(comment)}
                        >
                          重新绑定
                        </Button>
                      </Tooltip>,
                      <Tooltip title="标记为已解决" key="resolve">
                        <Button
                          type="link"
                          icon={<CheckCircleOutlined />}
                          onClick={() => handleResolveComment(comment.id)}
                        >
                          解决
                        </Button>
                      </Tooltip>,
                    ]
                  : [
                      <Tooltip title="标记为已解决" key="resolve">
                        <Button
                          type="link"
                          icon={<CheckCircleOutlined />}
                          onClick={() => handleResolveComment(comment.id)}
                        >
                          解决
                        </Button>
                      </Tooltip>,
                    ],
                <Tag color="orange" key="status">
                  待处理
                </Tag>
              )
            }
          />

          {resolvedComments.length > 0 && (
            <>
              <Divider orientation="left" orientationMargin={0}>
                已解决 ({resolvedComments.length})
              </Divider>
              <List
                dataSource={resolvedComments}
                renderItem={(comment) => (
                  <div style={{ opacity: 0.55 }}>
                    {renderCommentItem(
                      comment,
                      [],
                      <Tag color="green" key="status">
                        已解决
                      </Tag>
                    )}
                  </div>
                )}
              />
            </>
          )}
        </div>
      ),
    },
  ];

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
          columns={columns}
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
          items={editorTabs}
        />
      </Modal>

      <Modal
        title="重新绑定批注到最新稿"
        open={!!rebindTarget}
        onCancel={closeRebindModal}
        width={760}
        footer={null}
      >
        {rebindTarget && (
          <div>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="在下方最新稿中选中要绑定的文字，或按原高亮文本查找后由你选定具体位置。绑定成功后批注重新生效。"
            />
            <Paragraph style={{ marginBottom: 4 }}>
              <Text strong>批注内容：</Text>
              {rebindTarget.content}
            </Paragraph>
            {rebindTarget.highlighted_text && (
              <Paragraph style={{ marginBottom: 4 }}>
                <Text strong>原高亮文本：</Text>
                <Text mark>{rebindTarget.highlighted_text}</Text>
                {rebindTarget.version_number != null && (
                  <Tag style={{ marginLeft: 8 }}>{`来自 v${rebindTarget.version_number}`}</Tag>
                )}
              </Paragraph>
            )}

            <Divider orientation="left" orientationMargin={0}>
              最新稿{latestVersion ? ` (v${latestVersion.version_number})` : ''}
            </Divider>
            <div
              ref={previewRef}
              onMouseUp={handlePreviewMouseUp}
              style={{
                whiteSpace: 'pre-wrap',
                border: '1px solid #d9d9d9',
                borderRadius: 6,
                padding: 12,
                maxHeight: 240,
                overflow: 'auto',
                userSelect: 'text',
                cursor: 'text',
                marginBottom: 12,
              }}
            >
              {latestVersion?.content || ''}
            </div>

            {rebindSelection && (
              <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }}>
                <span>
                  已选中：
                  <Text mark>
                    {rebindSelection.text.length > 80
                      ? `${rebindSelection.text.slice(0, 80)}…`
                      : rebindSelection.text}
                  </Text>
                </span>
                <Button
                  type="primary"
                  icon={<LinkOutlined />}
                  loading={rebindLoading}
                  onClick={() =>
                    submitRebind({
                      start_position: rebindSelection.start,
                      end_position: rebindSelection.end,
                      highlighted_text: rebindSelection.text,
                    })
                  }
                >
                  绑定选中文字
                </Button>
              </Space>
            )}

            {rebindTarget.highlighted_text && (
              <Button
                icon={<AimOutlined />}
                onClick={handleLocate}
                loading={locateLoading}
                style={{ marginBottom: 12 }}
              >
                按原高亮文本查找
              </Button>
            )}

            {locateMatches && locateMatches.length === 0 && (
              <Alert
                type="warning"
                showIcon
                message="原高亮文本在最新稿中未找到，请在上方手动选中要绑定的文字。"
              />
            )}
            {locateMatches && locateMatches.length > 0 && (
              <div>
                <Paragraph type="secondary">
                  原高亮文本在最新稿中出现 {locateMatches.length} 处，请选定要绑定的一处：
                </Paragraph>
                <List
                  size="small"
                  bordered
                  dataSource={locateMatches}
                  renderItem={(match, index) => (
                    <List.Item
                      actions={[
                        <Button
                          type="link"
                          key="pick"
                          loading={rebindLoading}
                          onClick={() =>
                            submitRebind({
                              start_position: match.start_position,
                              end_position: match.end_position,
                              highlighted_text: locateText,
                            })
                          }
                        >
                          绑定到此处
                        </Button>,
                      ]}
                    >
                      <Space direction="vertical" size={2}>
                        <span>
                          第 {index + 1} 处：…{match.context}…
                        </span>
                        <span style={{ color: '#999', fontSize: 12 }}>
                          位置 {match.start_position} - {match.end_position}
                        </span>
                      </Space>
                    </List.Item>
                  )}
                />
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};

export default Documents;
