import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Col, Empty, Input, List, Modal, Row, Space, Spin, Typography } from 'antd'
import type { UserPreference } from '../types/preference'
import type { TravelPlan } from '../types/plan'
import { getPlan, health, listPlans, planByChat, planByForm, savePlan, type PlanSummary } from '../api/client'
import PreferenceForm from '../components/PreferenceForm'
import PlanView from '../components/PlanView'
import MapView from '../components/MapView'
import { emitPlan } from '../bridge'

// 记录最近一次请求，用于「一键采纳建议」时按原画像/原话重新生成
type LastRequest =
  | { kind: 'form'; pref: Partial<UserPreference> }
  | { kind: 'chat'; message: string; base?: Partial<UserPreference> }

export default function PlannerPage({ standalone = false }: { standalone?: boolean } = {}) {
  const [plan, setPlan] = useState<TravelPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [env, setEnv] = useState<{ amap_configured: boolean; ollama_available: boolean } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyList, setHistoryList] = useState<PlanSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const lastReqRef = useRef<LastRequest | null>(null)
  // 表单当前已填的部分画像：对话生成时作为「底」一并提交，避免对话解析覆盖表单的精确填写
  const formPrefRef = useRef<Partial<UserPreference>>({})

  useEffect(() => {
    health().then(setEnv).catch(() => setEnv(null))
  }, [])

  /**
   * 方案一变就广播出去，给外壳用。
   *
   * 需求是「把底部对话框的输出内容换成文旅工作台的样式」。外壳拿到这份 plan 后
   * 会用**同一个 PlanView 组件**渲染到对话框里，所以两处长得一模一样 ——
   * 也就不用在外壳里复刻一套样式，以后也不会只改到一边。
   * 单独跑这个应用（不走嵌入）时没人订阅，这里就是空转，没有副作用。
   *
   * `standalone`（内嵌副本）**不广播**：它自己就会把方案渲染在自己那一块里，
   * 再广播一次会让外壳以为"是我这次请求回来的"，可能把方案挂到另一条消息上。
   */
  useEffect(() => {
    if (standalone) return
    if (plan) emitPlan(plan)
  }, [plan, standalone])

  const run = async (req: LastRequest, apply = false) => {
    setLoading(true)
    setError(null)
    try {
      const p =
        req.kind === 'form'
          ? await planByForm(req.pref, apply)
          : await planByChat(req.message, apply, req.base)
      setPlan(p)
      lastReqRef.current = req
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleApply = async () => {
    if (!lastReqRef.current) return
    setApplying(true)
    try {
      await run(lastReqRef.current, true)
    } finally {
      setApplying(false)
    }
  }

  // 保存（覆盖）当前规划（含编辑结果）到后端，下次可从「历史计划」打开
  const handleSave = async () => {
    if (!plan) return
    try {
      await savePlan(plan)
      setNotice('已保存，可在「历史计划」中查看')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // 导出当前规划为 JSON 文件（便于离线保存 / 分享）
  const handleExport = () => {
    if (!plan) return
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `travelplan-${plan.plan_id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const openHistory = async () => {
    setHistoryOpen(true)
    setHistoryLoading(true)
    setError(null)
    try {
      setHistoryList(await listPlans())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setHistoryLoading(false)
    }
  }

  const loadPlan = async (id: string) => {
    try {
      const p = await getPlan(id)
      // 兼容旧计划（可能缺少新增的推荐池/出行人数/每晚酒店字段），兜底避免渲染崩溃
      setPlan({
        ...p,
        dining_options: p.dining_options || [],
        hotel_options: p.hotel_options || [],
        attraction_options: p.attraction_options || [],
        travelers: p.travelers || 1,
        daily_plans: (p.daily_plans || []).map((d) => ({ ...d, hotel: d.hotel || null })),
      })
      setHistoryOpen(false)
      setNotice('已加载历史计划')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: 16 }}>
      <Typography.Title level={3} style={{ marginTop: 8 }}>
        文旅智能辅助 · 个性化旅游规划
      </Typography.Title>

      {env && !env.amap_configured && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="未检测到高德密钥（AMAP_API_KEY）。请在 backend/.env 中配置后重启后端，否则无法获取实时 POI/天气数据。"
        />
      )}

      <Row gutter={16}>
        <Col xs={24} lg={8}>
          <PreferenceForm
            onSubmit={(pref) => run({ kind: 'form', pref })}
            onChange={(pref) => (formPrefRef.current = pref)}
            loading={loading}
            standalone={standalone}
          />

          <Card title="对话生成" size="small" style={{ marginTop: 12 }}>
            <Input.Search
              placeholder="例如：带80岁老人特种兵游杭州，3天，预算2000"
              enterButton="生成"
              loading={loading}
              onSearch={(value) => value && run({ kind: 'chat', message: value, base: formPrefRef.current })}
            />
          </Card>
        </Col>

        <Col xs={24} lg={16}>
          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
          {notice && (
            <Alert type="success" showIcon message={notice} closable onClose={() => setNotice(null)} style={{ marginBottom: 12 }} />
          )}
          <Spin spinning={loading}>
            {plan ? (
              <>
                <Space style={{ marginBottom: 12 }} wrap>
                  <Button onClick={handleSave}>保存计划</Button>
                  <Button onClick={handleExport}>导出 JSON</Button>
                  <Button onClick={openHistory}>历史计划</Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    可移除景点 / 换餐厅，预算与地图将实时更新
                  </Typography.Text>
                </Space>
                <PlanView plan={plan} onApplySuggestions={handleApply} applying={applying} onUpdate={setPlan} />
                <MapView plan={plan} />
              </>
            ) : (
              <Card>
                <Empty description="填写偏好或输入一句话，生成你的专属旅行规划" />
              </Card>
            )}
          </Spin>
        </Col>
      </Row>

      <Modal title="历史计划" open={historyOpen} footer={null} onCancel={() => setHistoryOpen(false)}>
        <List
          loading={historyLoading}
          dataSource={historyList}
          locale={{ emptyText: '暂无历史计划' }}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Button key="load" type="link" onClick={() => loadPlan(item.plan_id)}>
                  打开
                </Button>,
              ]}
            >
              <List.Item.Meta title={item.summary} description={item.created_at} />
            </List.Item>
          )}
        />
      </Modal>
    </div>
  )
}
