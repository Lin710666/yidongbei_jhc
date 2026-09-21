import { useEffect } from 'react'
import { Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Row, Select } from 'antd'
import type { UserPreference } from '../types/preference'
import { subscribeGenerate, subscribePreference } from '../bridge'

// 可选值配置
//
// 兴趣里补了「文艺打卡 / 购物」：这两个是词云上有的选项，原来这张表里没有，
// 词云点过来就会变成一个没有候选的空值（antd 只会把原始值当标签显示，
// 再点开下拉是找不到它的）。补齐之后两边的词表才是一致的。
const PREFERENCE_OPTIONS = ['人文历史', '自然风光', '美食', '娱乐', '文艺打卡', '购物']
const PACE_OPTIONS = ['悠闲', '适中', '特种兵']
const TRANSPORT_OPTIONS = ['自驾', '高铁', '飞机', '本地']
const AVOID_OPTIONS = ['爬山', '排队', '网红打卡']
const DIET_OPTIONS = ['海鲜', '清真', '素食', '无辣']

interface Props {
  onSubmit: (pref: Partial<UserPreference>) => void
  onChange?: (pref: Partial<UserPreference>) => void
  loading?: boolean
  /** 内嵌副本（见 App.tsx 的说明）：不接外壳广播，避免两份实例同时响应 */
  standalone?: boolean
}

// 从表单值构建「仅含已填字段」的部分画像（表单生成 + 对话合并复用）
function buildPartial(values: Record<string, unknown>): Partial<UserPreference> {
  const partial: Partial<UserPreference> = {}
  if (values.destination) partial.destination = values.destination as string
  if (values.origin) partial.origin = values.origin as string
  if (values.duration_days != null) partial.duration_days = values.duration_days as number
  if (values.budget != null) partial.budget = values.budget as number
  if ((values.preferences as string[])?.length) partial.preferences = values.preferences as string[]
  if ((values.must_visit as string[])?.length) partial.must_visit = values.must_visit as string[]
  if (values.pace) partial.pace = values.pace as UserPreference['pace']
  if (values.transportation) partial.transportation = values.transportation as UserPreference['transportation']
  if ((values.dietary_restrictions as string[])?.length)
    partial.dietary_restrictions = values.dietary_restrictions as string[]
  if ((values.avoidances as string[])?.length) partial.avoidances = values.avoidances as string[]
  if (values.start_date) partial.start_date = (values.start_date as { format: (f: string) => string }).format('YYYY-MM-DD')

  const { adults, children, elderly } = values as Record<string, number | undefined>
  if (adults != null || children != null || elderly != null) {
    partial.travelers = { adults: adults ?? 0, children: children ?? 0, elderly: elderly ?? 0 }
  }
  return partial
}

/**
 * 极简表单（零门槛）：
 * 所有字段均可选填，留空则后端用默认值补齐；
 * 填写更多细节，生成的规划会更贴合。
 */
export default function PreferenceForm({ onSubmit, onChange, loading, standalone = false }: Props) {
  const [form] = Form.useForm()

  /**
   * 接外壳（词云）同步过来的条件。
   *
   * 词云上点「杭州 / 舒适 / 亲子」这些词，数据会从 bridge 送进来，这里写进表单，
   * 用户就能在界面上看见自己点了什么 —— 不再只靠底下一行字幕。
   *
   * 两个细节：
   *  1. setFieldsValue 是增量合并，不会清掉用户自己已经填的其它字段。
   *  2. antd 的 setFieldsValue **不会**触发 onValuesChange，所以这里手动回调一次
   *     onChange，否则 PlannerPage 里那份「表单已填画像」（对话生成时当底稿用）
   *     会跟界面对不上。
   */
  useEffect(() => {
    if (standalone) return              // 内嵌副本不接广播，见 App.tsx
    return subscribePreference((patch) => {
      if (!patch || Object.keys(patch).length === 0) return
      form.setFieldsValue(patch as Record<string, unknown>)
      onChange?.(buildPartial(form.getFieldsValue()))
    })
  }, [form, onChange, standalone])

  // 词云点「个性化方案」时，由外壳请求这里直接提交一次
  useEffect(() => {
    if (standalone) return              // 同上：否则两份实例会各提交一次，打两次 /api/plan
    return subscribeGenerate(() => {
      form.submit()
    })
  }, [form, standalone])

  const handleFinish = (values: Record<string, unknown>) => {
    onSubmit(buildPartial(values))
  }

  return (
    <Card title="告诉我你的旅行偏好">
      <Alert
        type="info"
        showIcon
        message="输入详细信息可以生成更适合您的旅行规划哦！所有字段均可选填。"
        style={{ marginBottom: 16 }}
      />
      <Form
        form={form}
        layout="vertical"
        onFinish={handleFinish}
        onValuesChange={(_, all) => onChange?.(buildPartial(all))}
      >
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="destination" label="目的地">
              <Input placeholder="例如：杭州（留空默认杭州）" allowClear />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="origin" label="出发地">
              <Input placeholder="例如：上海（选填）" allowClear />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="must_visit" label="特别想去的景点">
              <Select
                mode="tags"
                placeholder="输入景点名后回车，如：雷峰塔、西湖（选填）"
                allowClear
                tokenSeparators={['、', '，', ',']}
                open={false}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="adults" label="成人">
              <InputNumber min={0} placeholder="0" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="children" label="儿童">
              <InputNumber min={0} placeholder="0" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="elderly" label="老人">
              <InputNumber min={0} placeholder="0" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="duration_days" label="游玩天数">
              <InputNumber min={1} max={30} placeholder="例如：3" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="budget" label="总预算（元）">
              <InputNumber min={0} placeholder="例如：3000" prefix="¥" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="preferences" label="兴趣导向">
              <Select
                mode="multiple"
                placeholder="选填，可多选"
                allowClear
                options={PREFERENCE_OPTIONS.map((o) => ({ label: o, value: o }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="pace" label="游玩节奏">
              <Select
                placeholder="选填"
                allowClear
                options={PACE_OPTIONS.map((o) => ({ label: o, value: o }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="transportation" label="往返交通">
              <Select
                placeholder="选填"
                allowClear
                options={TRANSPORT_OPTIONS.map((o) => ({ label: o, value: o }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="avoidances" label="讨厌的项目">
              <Select
                mode="multiple"
                placeholder="选填，可多选"
                allowClear
                options={AVOID_OPTIONS.map((o) => ({ label: o, value: o }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="dietary_restrictions" label="饮食禁忌">
              <Select
                mode="multiple"
                placeholder="选填，可多选"
                allowClear
                options={DIET_OPTIONS.map((o) => ({ label: o, value: o }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="start_date" label="出行日期">
              <DatePicker style={{ width: '100%' }} placeholder="选填" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item style={{ marginBottom: 0 }}>
          <Button type="primary" htmlType="submit" loading={loading} block>
            生成我的旅行规划
          </Button>
        </Form.Item>
      </Form>
    </Card>
  )
}
