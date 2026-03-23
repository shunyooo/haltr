<p align="center">
  <h1 align="center">haltr</h1>
  <p align="center">
    コーディングエージェントの自律性を高めるフレームワーク
  </p>
  <p align="center">
    <a href="#インストール">インストール</a> · <a href="#使い方">使い方</a> · <a href="#仕組み">仕組み</a> · <a href="#コマンド一覧">コマンド一覧</a>
  </p>
  <p align="center">
    <a href="./README.md">English</a> | 日本語
  </p>
</p>

---

## 解決する問題

コーディングエージェントは、人間が張り付いて対話・方向修正・レビューを行わないとまともなアウトプットが出せません。エージェントは「道具」であり、人間が操縦し続ける必要があります。

haltr は**エージェントが自律的に長時間作業し、高品質なアウトプットを出せる状態**を目指します。

```
1度やることを決めたら、あとはエージェントが数時間、
自律的に作業し、高品質なアウトプットを出す。
```

人間は最初の意思決定と最終確認だけ。途中の品質担保は haltr が行います。

## 特徴

- **hal コマンドが唯一のインターフェース** — エージェントは `hal` コマンドで品質ゲート・状態管理・知識管理を行います。CLI 非依存（Claude Code / Codex / Gemini CLI 等どこからでも使える）
- **エージェントの自律性を支援** — 管理するのではなく、エージェントが自律的に動ける仕組みを提供します
- **外部記憶によるコンテキスト劣化対策** — task.yaml + プランファイル + notes.md で長時間作業でも方向を見失わない
- **品質ゲート** — ステップ完了時に accept 条件をチェック。Stop hook で早期離脱を防止
- **知識のライフサイクル管理** — skills（方法論）と knowledge（ドメイン知識）を蓄積・参照・陳腐化検知
- **コマンドヒントによるリマインド** — hal コマンドの返り値で次の動線を常にガイド

## インストール

```bash
npm install -g haltr
```

### 必要なもの

- Node.js >= 20
- コーディングエージェントの CLI（`claude` 等）

## 使い方

### セットアップ（初回のみ）

```bash
hal init
```

`haltr/` ディレクトリが作成されます。以下も設定してください：

1. `CLAUDE.md` に `@haltr/README.md` を追加（Claude Code の場合）
2. SessionStart hook に `haltr/` 内の `session-start-hook.sh` を設定

### ワークフロー

ユーザーは普通に Claude Code を起動するだけ。haltr/README.md が自動ロードされ、エージェントが hal コマンドを使いながら作業します。

```
ユーザー: 「ログイン機能を実装して」
  ↓
エージェント: プランファイル（plan.md）を作成
ユーザー: フィードバック → ブラッシュアップ → 「OK」
  ↓
エージェント: hal task create → hal step add → hal step start
  ↓ 自律実行（ユーザーは放置）
エージェント: 実装 → notes.md に記録 → hal step done --result PASS
  ↓ ステップを繰り返す
全ステップ完了 → CCR（クロスコンテキスト検証）→ 完了報告
```

途中で確認したい場合は `hal step pause` で copilot モードに切り替え、エージェントと直接対話できます。`hal step resume` で自律実行に戻ります。

## 仕組み

### アーキテクチャ

```
メインワーカー（1セッション、全てやる）
  │
  ├─ hal コマンド（データ管理のみ。LLM は呼ばない）
  │   ├─ hal task create/edit    — タスク管理
  │   ├─ hal step add/start/done — ステップ管理 + 品質ゲート
  │   ├─ hal step pause/resume   — copilot/autopilot 切替
  │   ├─ hal context *           — 知識管理（CRUD + イベント記録）
  │   ├─ hal check               — Stop hook 用（早期離脱防止）
  │   └─ hal status              — 進捗確認
  │
  ├─ task.yaml（外部記憶 — 状態管理）
  ├─ plan.md（外部記憶 — 方法論）
  ├─ notes.md（外部記憶 — 作業メモ）
  │
  ├─ haltr/context/（知識管理 — skills + knowledge）
  │
  └─ サブエージェント（必要時のみ、Worker 自身がスポーン）
      └─ verifier（CCR 用）
```

hal はデータ管理に徹します。LLM 呼び出しやエージェントスポーンは行いません。判断と実行はエージェントの責務です。

### task.yaml

タスクの状態を管理するファイル。人間が意識する必要はありません。

```yaml
id: implement-auth
goal: "Google OAuth でログイン機能を実装する"
accept:
  - "npm test -- --grep 'auth' が exit 0"
  - "playwright で /login のフローを確認"
plan: 001_plan.md
notes: 001_notes.md
status: in_progress

steps:  # エージェントが自律管理
  - id: setup
    goal: "OAuth クライアントのセットアップ"
    status: done
  - id: implement
    goal: "認証フローの実装"
    accept:
      - "npm test passes"
    status: in_progress

history:
  - at: "2026-03-23T10:00:00Z"
    type: created
    message: "タスク作成"
```

### 外部記憶の分離

| ファイル | 役割 | 誰が書くか |
|----------|------|-----------|
| **plan.md** | 方法論の記述（何をどの順序でやるか） | 人間とエージェントが対話で詰める |
| **task.yaml** | 状態管理（goal, accept, steps, history） | エージェントが hal コマンド経由で更新 |
| **notes.md** | 作業メモ（中間結果、発見事項） | エージェントが直接編集 |

### 品質ゲート

```
Layer 1: 決定的検証 + 軌道修正（step 完了時）
  エージェントが accept 条件を検証 → hal step done で報告

Layer 2: クロスコンテキスト検証（タスク完了時）
  異なる LLM のサブエージェントで独立検証（CCR）

Layer 3: 人間レビュー（最終確認）
  必要な時だけ介入
```

### 知識管理

```
haltr/context/
  index.yaml        — 統合インデックス（description リスト）
  history.yaml      — 使用履歴（イベントログ）
  skills/           — 方法論（SKILL.md フォーマット）
  knowledge/        — ドメイン知識
```

## コマンド一覧

### タスク管理

| コマンド | 説明 |
|---------|------|
| `hal task create --goal "..." --accept "..."` | タスクを作成 |
| `hal task edit --goal "..." --message "理由"` | タスクを編集 |

### ステップ管理

| コマンド | 説明 |
|---------|------|
| `hal step add --step <id> --goal "..."` | ステップを追加 |
| `hal step start --step <id>` | ステップを開始 |
| `hal step done --step <id> --result PASS` | ステップ完了を報告 |
| `hal step pause` | copilot モードに切替 |
| `hal step resume` | autopilot モードに復帰 |

### 知識管理

| コマンド | 説明 |
|---------|------|
| `hal context list` | skills + knowledge の一覧 |
| `hal context show --id <id>` | 内容表示 + used 記録 |
| `hal context create --type skill --id <id> --description "..."` | 新規作成 |
| `hal context delete --id <id> --reason "..."` | 削除 |
| `hal context log --id <id> --type updated --message "..."` | イベント記録 |

### その他

| コマンド | 説明 |
|---------|------|
| `hal init` | haltr/ ディレクトリを初期化 |
| `hal status` | 現在の状態を表示 |
| `hal check` | Stop hook 用ゲートチェック |
| `hal epic create <name>` | エピックを作成 |
| `hal epic list` | エピック一覧 |

## 設計原則

1. **自律性のための構造** — エージェントを管理するのではなく、自律的に動けるよう支援する
2. **削除を前提に設計する（Bitter Lesson）** — モデルが進化すれば不要になる構造は最小限に
3. **検証可能なゴール > 冗長な仕様** — accept 条件を具体的かつ検証可能に
4. **コンテキストの質 > エージェントの数** — 1つのエージェントに適切なコンテキストを提供
5. **hal はデータ管理に徹する** — LLM 呼び出し・エージェントスポーンはしない

## 設計の経緯

### なぜマルチエージェント構成にしなかったのか？

haltr v1 はオーケストレーター + ワーカー + ベリファイアーのマルチエージェント構成でした。しかし実運用で以下の問題が発生しました。

- **伝言ゲーム** — orchestrator がユーザーの意図を worker に伝える過程で情報が劣化する。修正のたびに orchestrator を経由するため、修正サイクルが遅い
- **コンテキスト損失** — step ごとに worker を kill → re-spawn すると、前の step で得た暗黙知が失われる。step を細かく切るほど品質が下がるという矛盾
- **オーバーヘッド** — 簡単な修正でもフルフローが走る。ユーザーが「普通に Claude Code でやった方が早い」と感じる

これは haltr だけの問題ではありません。[Google/MIT の研究（2025年12月）](https://arxiv.org/html/2512.08296v1)では、逐次的なタスクでマルチエージェントを使うと **-39〜70% の性能低下** が確認されています。[Microsoft Azure SRE チーム](https://techcommunity.microsoft.com/blog/appsonazureblog/context-engineering-lessons-from-building-azure-sre-agent/4481200/)は 50+ のエージェントを数個の汎用エージェントに統合しました。4回以上のハンドオフでほぼ必ず失敗するとも報告しています。

> "most coding tasks involve fewer truly parallelizable tasks than research, and LLM agents are not yet great at coordinating and delegating to other agents in real time."
>
> （「ほとんどのコーディングタスクはリサーチより並列化可能なタスクが少なく、LLM エージェントはまだリアルタイムでの他エージェントへの調整・委譲が得意ではない」）
>
> — Anthropic

v2 ではメインワーカー1つに統合し、haltr はデータ管理（task.yaml + 品質ゲート + 知識管理）に徹する設計にしました。

### なぜ hal はLLM を呼ばないのか？

hal コマンドの中で LLM を呼ぶ設計も検討しましたが、やめました。

- **責務の分離** — 判断はエージェント、記録は hal。境界が明確になる
- **実装のシンプルさ** — hal に LLM クライアントを持たせると、API キー管理・モデル選択・エラーハンドリングが必要になる
- **CLI 非依存** — hal が特定の LLM API に依存すると、CLI 非依存の原則が崩れる
- **テスタビリティ** — データ管理だけなら決定的にテストできる

### なぜ Spec-driven にしなかったのか？

Spec-driven development（事前に詳細な仕様を書いてからエージェントに実装させる）も検討しましたが、採用しませんでした。

[Birgitta Boeckeler（Thoughtworks）](https://martinfowler.com/)は3つの SDD ツールを評価し、「同じ時間でプレーンな AI コーディングで実装できた」と報告しています。[Colin Eberhardt（Scott Logic）](https://blog.scottlogic.com/)は定量比較で **SDD なしの方が約10倍速い** という結果を出しています。

> "A spec detailed enough to fully describe a program is more or less the program, just written in a non-executable language."
>
> （「プログラムを完全に記述するほど詳細な仕様は、実行不能な言語で書かれたプログラムそのものだ」）
>
> — Addy Osmani（Google）

haltr では、重い仕様ではなく**軽量なプランファイル**（対話で詰めた合意内容）と**検証可能な accept 条件**の組み合わせを選びました。

### Bitter Lesson: 構造は最小限に

> "Design for deletion."
>
> （「削除を前提に設計せよ」）
>
> — Microsoft Azure SRE

モデルは急速に進化しています。GPT-3.5 用の複雑なオーケストレーションは GPT-4 で不要になりました。Claude 2 用のマルチステップ推論チェーンは Claude 3 で単一プロンプトに置き換わりました。

haltr が足す構造はすべて「今のモデルでは必要だが、将来のモデルでは不要になるかもしれない」という前提で設計しています。各機能について「この構造を削除したら、エージェントは自律的に動けなくなるか？」を問い、Yes のものだけを残しています。

### クロスコンテキスト検証（CCR）の根拠

[Song（2026）の研究](https://arxiv.org/html/2603.12123)で、独立コンテキストでのレビューが同一セッション自己レビューより有効であることが実証されています（F1: 28.6% vs 24.6%）。同一セッションで2回レビューしても改善しない（21.7%）ことから、繰り返しではなく**文脈分離**が重要であることがわかっています。

ただし効果は控えめであり、「銀の弾丸」ではありません。haltr では品質スタックの一層として位置づけ、タスク完了時にエージェント自身がサブエージェントとして実行する形を取っています。

## 開発

```bash
npm install          # 依存インストール
npm run build        # ビルド
npm run lint         # Biome によるリント
npm run test         # 全テスト実行
npm run test:schema  # スキーマバリデーションテスト
npm run test:commands # コマンドテスト
npm run test:e2e     # E2E テスト
```

## ライセンス

MIT
