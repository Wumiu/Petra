/** 小游戏模块公共类型 */
export interface MiniGameContext {
  /** 游戏容器（全窗口覆盖层，已带 data-petra-interactive） */
  root: HTMLElement;
  /** 关闭游戏（恢复桌宠漫游） */
  close: () => void;
}

export interface MiniGameInstance {
  unmount?: () => void;
}

export interface MiniGameDef {
  id: string;
  name: string;
  emoji: string;
  desc: string;
  /** 挂载游戏；返回实例用于清理 */
  mount: (ctx: MiniGameContext) => MiniGameInstance;
}
