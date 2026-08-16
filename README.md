# dsh-token-meter

DeepSeek Harness (dsh) 模型用量仪表盘插件 —— 设置页「统计」板块,按服务商/模型汇总全部会话的 token 用量。


## 功能

- **设置页「统计」板块**:汇总全部会话的 token 用量,按服务商/模型分组
- **时间范围切换**:胶囊开关,今日 / 最近 7 天 / 最近 30 天
- **按天 Token 趋势**:堆叠柱状图(按模型着色),Chart.js 本地托管,无 CDN
- **模型用量环形图**:占比 + token 数图例
- **主题自适应**:全部使用 dsh 官方 CSS 变量,随日间/深色主题切换
- **导航图标**:设置页导航「统计」板块使用 Remix Icon 柱状图图标(字体本地托管)

## 安装

前置:已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh web` 可运行)。

### 方式一:GitHub 源

```sh
dsh plugin --profile web add github:Nai99/dsh-token-meter#main
```

### 方式二:本地目录(开发调试)

```sh
git clone https://github.com/Nai99/dsh-token-meter.git
dsh plugin --profile web add /path/to/dsh-token-meter
```

安装后**重启 `dsh web`**,刷新浏览器,打开设置页即可看到「统计」板块。

## 使用

1. 打开设置页(侧栏设置入口),左侧导航点击「统计」;
2. 顶部胶囊切换时间范围(今日 / 7 天 / 30 天),数据每分钟自动刷新,也可点「刷新」;
3. 趋势图为按天按模型的 token 堆叠柱状图;环形图展示各模型用量占比;
4. 右上角「在新窗口打开仪表盘」可查看独立页面。

## 数据

- 用量来自会话事件中的 usage 统计,增量归并后持久化在 `~/.dsh/storages/usage-meter.json`(原子写入)
- 历史数据随插件保留,改名/升级不丢失

## 致谢

- 本项目 fork 自 [dsh-usage-meter](https://github.com/V-dev-388/dsh-usage-meter)(MIT,作者 V-dev-388):数据归并、会话统计与图表核心逻辑均源自上游,感谢原作者的工作;
- 图标字体使用 [Remix Icon](https://remixicon.com/)(Apache 2.0 / MIT 双许可);
- 图表使用 [Chart.js](https://www.chartjs.org/)(MIT)。

## 许可证

[MIT](LICENSE)
