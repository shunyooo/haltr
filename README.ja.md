<p align="center">
  <h1 align="center">haltr</h1>
  <p align="center">
    コーディングエージェントの出力品質を、エージェント自身に担保させる
  </p>
  <p align="center">
    <a href="#インストール">インストール</a> · <a href="#使い方">使い方</a> · <a href="#仕組み">仕組み</a> · <a href="#コマンド一覧">コマンド一覧</a> · <a href="#設定">設定</a>
  </p>
  <p align="center">
    <a href="./README.md">English</a> | 日本語
  </p>
</p>

---

## 解決する問題

エージェントが「完了しました」と言っても、実際にはテストが通っていなかったり、要件の一部をスキップしていたり、既存機能を壊していたりします。

結局、人間がセッションを逐一監視して、手動でテストを走らせて、「本当に確認した？」と何度も聞くことになります。これでは自律エージェントを使う意味がありません。

haltr は**作業と検証を別のエージェントに分離**することで、この問題を解決します。さらに、作業者と検証者には**異なる LLM** を使います。同じ LLM だと同じバイアスを共有してしまい、見落としが検証でも見つからないためです。

```
人間: 「ログイン機能を実装して」
 ↓
haltr がステップと受入条件を構造化
 ↓
Worker（Claude）が実装
 ↓
Verifier（Codex / Gemini）が独立検証
 ↓
FAIL → 修正 → 再検証（自動ループ）
 ↓
全ステップ PASS → 人間に報告
```

人間がやるのは最初の指示と最終確認だけです。途中の品質担保は haltr が回します。

### 既存ツールとの比較

|  | haltr | Ruflo (21.7k★) | Gas Town (12.5k★) | agent-orchestrator (4.8k★) |
|:---|:---:|:---:|:---:|:---:|
| クロス CLI 検証（作業者 ≠ 検証者の LLM） | ✅ | ❌ | ❌ | ❌ |
| CLI 非依存（Claude / Codex / Gemini） | ✅ | ❌¹ | ❌¹ | ✅ |
| 独立した検証エージェント | ✅ | ❌ | ❌ | ❌ |
| スペックドリブン（構造化された受入条件） | ✅ | ❌ | ❌ | △ |
| 途中からの人間介入・ピボット | ✅ | ❌ | ❌ | ❌ |
| 人間 + agent の混合検証 | ✅ | ❌ | ❌ | ❌ |
| 自動リトライループ | ✅ | ✅ | ✅ | ✅ |
| ファイルベース（YAML が Single Source of Truth） | ✅ | ❌ | ❌ | ✅ |
| pane クラッシュ検知・自動通知 | ✅ | ❌ | ✅ | ❌ |

<sub>¹ Claude Code 専用</sub>

既存のオーケストレーション系ツールは**水平スケール**（複数 Issue を並列処理）に注力しています。haltr は**垂直スケール**（1タスクの品質担保）に注力しており、クロス CLI による独立検証とスペックドリブンな受入条件が最大の違いです。

## インストール

```bash
npm install -g haltr
```

### 必要なもの

- Node.js >= 20
- tmux >= 3.0
- コーディングエージェントの CLI（`claude`, `codex`, `gemini` のうち1つ以上）

## 使い方

### セットアップ（初回のみ）

```bash
hal init
```

### セッション開始

```bash
hal start
```

これだけです。tmux セッションが立ち上がり、pane 0 にオーケストレーターエージェントが起動します。あとはオーケストレーターに指示を出してください。

```
あなた: 「ログイン機能を実装して」
   ↓
orchestrator がエピック・タスクを作成し、ステップと受入条件を定義
   ↓
hal spawn worker → 実装エージェントが起動
   ↓
worker 完了 → hal spawn verifier → 別の LLM が独立検証
   ↓
PASS → 次のステップ / FAIL → フィードバック付きでリトライ
```

エピックの作成、タスクの定義、ステップや受入条件の設計は**オーケストレーターが対話の中でやります**。`hal` コマンドは人間が直接叩くものではなく、**エージェントが使う CLI** です。人間はオーケストレーターとの対話を通じてワークフローを制御します。

途中で方向転換したくなったら、オーケストレーターに伝えるか、`hal task edit` で直接タスク定義を編集できます。

## 仕組み

### 全体像

```
┌───────────────────────────────────────────┐
│  haltr（ワークフロー層）                    │
│  ├── task.yaml の管理                      │
│  ├── 受入条件の検証                         │
│  ├── 履歴の追跡                            │
│  ├── ステップの実行制御                      │
│  └── リトライ / エスカレーション / ピボット    │
├───────────────────────────────────────────┤
│  Runtime Interface                        │
│  spawn / kill / send / list / isAlive     │
├───────────────────────────────────────────┤
│  Agent Runtime（差し替え可能）               │
│  └── v1: tmux（pane ベース）               │
└───────────────────────────────────────────┘
```

ワークフローと runtime は分離されています。haltr はワークフローロジックだけを持ち、エージェントの起動・管理・通信は runtime が担当します。v1 では tmux ですが、将来は SDK ベースや Docker ベースに差し替えられる設計です。

### 流れ

1. **オーケストレーター**が `task.yaml` を読んで、次の pending ステップの **worker** を spawn します
2. Worker が作業を終えると `hal check --worker` で完了を通知します（stop hook 経由）
3. オーケストレーターが別の CLI で **verifier** を spawn し、受入条件を独立検証します
4. PASS なら次のステップへ。FAIL なら verifier のフィードバックを添えてリトライします
5. バックグラウンドで **watcher** が pane の生死を監視し、クラッシュ時にオーケストレーターへ通知します

### task.yaml

タスクの定義、状態、履歴、コンテキストを1ファイルに集約します。

```yaml
id: implement-auth
status: in_progress
agents:
  worker: claude        # 実装は Claude
  verifier: codex       # 検証は Codex

steps:
  - id: api-endpoints
    goal: "認証 API のエンドポイントを実装する"
    accept: "npm test -- --grep 'auth' が exit 0 で通ること"

  - id: ui-flow
    goal: "ログイン/サインアップの UI を作る"
    accept:
      - id: tests
        check: "npm test -- --grep 'login' が exit 0 で通ること"
      - id: visual
        type: human                                        # 人間が目視確認
        instruction: "/login を開いて動作確認"

  - id: docs
    goal: "認証 API のドキュメントを書く"
    # accept なし = 探索的タスク

context: |
  セッション管理は JWT。
  OAuth は Google と GitHub に対応。
```

- `goal` — 何を達成するかを記述します。全ステップ必須です
- `accept` — 受入条件です。あれば verifier が検証し、なければ agent か人間が判断します
- `accept` に `type: human` を指定すると、人間による確認になります
- ステップは再帰的にネストできます（`steps` の中に `steps`）

### ディレクトリ構成

```
haltr/
├── config.yaml              # グローバル設定
├── rules.md                 # プロジェクトルール（全 agent に注入されます）
├── agents/                  # ロールごとの agent 定義
│   ├── worker.yaml
│   ├── verifier.yaml
│   └── ...
└── epics/
    ├── 20260319-001_implement-auth/
    │   ├── 001_task.yaml    # タスク定義
    │   ├── .panes.yaml      # pane の追跡（runtime が管理）
    │   └── .hooks/          # spawn 時に生成
    └── archive/             # 完了したエピック
```

エピック内のファイルは連番で管理されます。タスク定義、調査コード、レポートが時系列で並ぶので、探索→発見→ピボットの流れを自然に追えます。

## コマンド一覧

### 初期化

| コマンド | 説明 |
|---------|------|
| `hal init` | `haltr/` を作成して初期化します |

### エピック

| コマンド | 説明 |
|---------|------|
| `hal epic create <name>` | エピックを作成します |
| `hal epic list` | エピック一覧を表示します |
| `hal epic current` | 最新のエピックを表示します |
| `hal epic archive <name>` | エピックをアーカイブに移動します |

### タスク

| コマンド | 説明 |
|---------|------|
| `hal task new <epic>` | 新規タスクを作成します（前タスクがあればピボット） |
| `hal task edit [--field --value]` | `$EDITOR` で編集、またはフィールドを直接更新します |

### セッション制御

| コマンド | 説明 |
|---------|------|
| `hal start [--task] [--cli]` | tmux セッションを開始します |
| `hal spawn <role> [--step] [--task]` | agent pane を追加します（worker / verifier / sub-orchestrator 等） |
| `hal stop` | セッションと watcher を停止します |
| `hal kill --task <path>` | タスクの全 pane を停止します |

### 完了ゲート

| コマンド | 説明 |
|---------|------|
| `hal check --worker` | worker の完了判定です（stop hook から自動実行） |
| `hal check --verifier` | verifier の完了判定です（stop hook から自動実行） |
| `hal check --orchestrator` | ステップの完了を判定します |
| `hal escalate --task --step` | worker から問題を報告します（ステータスが blocked に） |

### 状態管理

| コマンド | 説明 |
|---------|------|
| `hal status <target> <status>` | ステップ/タスクのステータスを変更します |
| `hal history add --type <type>` | 履歴イベントを追加します |
| `hal history list --task <path>` | 履歴を表示します |
| `hal panes` | pane 一覧を表示します |

### その他

| コマンド | 説明 |
|---------|------|
| `hal rule add "<rule>"` | ルールを追加します |
| `hal rule list` | ルールを表示します |
| `hal layout <type>` | tmux レイアウトを変更します |
| `hal hook guard-bash <cmd>` | `hal` 以外のコマンドをブロックします（hook 用） |

## 設定

### config.yaml

```yaml
orchestrator_cli: claude        # オーケストレーターの CLI
watcher:
  poll_interval: 30             # pane 監視の間隔（秒）
  inactivity_threshold: 300     # 無応答アラートまでの時間（秒）
panes:
  max_concurrent: 10            # pane の同時最大数
retry:
  max_attempts: 3               # ステップごとの最大リトライ回数
```

### CLI の解決順序

ロールごとに使う CLI は、より具体的な指定が優先されます:

**Worker**: step.agents.worker → task.agents.worker

**Verifier**: accept[].verifier → step.agents.verifier → task.agents.verifier

**オーケストレーター系**: config.orchestrator_cli

## 開発

```bash
npm install          # 依存インストール
npm run build        # ビルド
npm run lint         # Biome によるリント

# テスト（マイルストーン別）
npm run test:m1      # スキーマ・バリデーション
npm run test:m2      # ディレクトリ・タスク管理
npm run test:m3      # 履歴・ステータス
npm run test:m4      # Hook ゲート
npm run test:m5      # tmux ランタイム
npm run test:m6      # Spawn・Start
npm run test:m7      # サポートコマンド
npm run test:m8      # Agent 定義・Watcher
npm run test:m9a     # E2E（前半）
npm run test:m9b     # E2E（後半）
```

## ライセンス

MIT
