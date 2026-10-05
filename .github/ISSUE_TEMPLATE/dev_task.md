---
name: 开发任务
about: 团队内部的功能开发任务，配合关联分支使用
title: "[Feature] "
labels: enhancement
assignees: ''

---

## 目标

一句话说明这个功能要做什么、给谁用。

## 验收标准

- [ ] 标准一
- [ ] 标准二
- [ ] 标准三

## 关联分支

建分支的命令（把 `<本 issue 编号>` 换成当前编号）：

```
gh issue develop <本 issue 编号> --name <分支名> --base master --checkout
```

建好后本 issue 右侧的 **Development** 栏会自动列出这个分支，点进去能看到提交和 PR。

## 推进状态

- [ ] 已建关联分支
- [ ] 开发中
- [ ] 已提 PR（PR 描述里写 `Closes #<本 issue 编号>`，合并后本 issue 自动关闭）

## 补充说明

（可选）实现思路、参考、需要注意的坑。
