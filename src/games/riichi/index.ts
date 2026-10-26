/** 立直麻将小游戏注册入口 */
import { registerMiniGame } from "../host";
import { mountRiichi } from "./view";

export function registerRiichiGame(): void {
  registerMiniGame({
    id: "riichi",
    name: "立直麻将（双人）",
    emoji: "🀄",
    desc: "和桌宠一对一立直麻将：碰、杠、立直、宝牌、番数算点，桌宠会实时反应",
    mount: (ctx) => mountRiichi(ctx),
  });
}
