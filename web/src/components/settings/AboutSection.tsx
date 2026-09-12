export function AboutSection() {
  return (
    <div className="space-y-6">
      {/* 项目信息 */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1">
          智牧工作台
        </h2>
        <p className="text-sm text-muted-foreground">
          自托管、Pi Agent 驱动的多渠道智能体工作台
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          版本 0.2.0 · MIT License
        </p>
      </div>

      {/* 功能边界说明 */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm leading-6 text-muted-foreground">
        <p className="font-medium text-foreground">当前版本已落地的能力：</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>SSE 流式对话（工具调用可视化 + 写操作确认回路）</li>
          <li>工作区记忆（fact / decision / lesson / open_loop，CAS 并发控制）</li>
          <li>智能体身份 Persona（四段 prompt + 不可变版本快照）</li>
          <li>定时任务（固定间隔 / 每天定时 / 指定时间）</li>
          <li>飞书 / 钉钉渠道接入（凭据服务端加密）</li>
          <li>多用户与工作区成员（owner / admin / member）</li>
        </ul>
      </div>
    </div>
  );
}
