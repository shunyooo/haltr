# haltr Operation Guide

haltr はコーディングエージェントの出力品質を担保するツールです。全てのタスクは hal コマンドで管理します。

## Command Reference

| Command | Description |
|---------|-------------|
| `hal status` | 現在のタスク状態を表示 |
| `hal task create --goal '<goal>' [--accept '<criteria>']` | タスク作成 |
| `hal task edit --goal '<goal>' --message '<reason>'` | タスクのゴール更新 |
| `hal step add --step <id> --goal '<goal>' [--accept '<criteria>']` | ステップ追加 |
| `hal step start --step <id>` | ステップ開始 |
| `hal step done --step <id> --result PASS\|FAIL [--message '<msg>']` | ステップ完了報告 |
| `hal context list` | コンテキスト一覧 |
| `hal context show --id <id>` | コンテキスト内容表示 |
| `hal context create --type <skill\|knowledge> --id <id> --description '<desc>'` | コンテキスト作成 |
| `hal context log --id <id> --type <updated\|confirmed\|deprecated\|promoted>` | コンテキスト履歴記録 |
| `hal check` | Stop hook ゲートチェック |

## Workflow

1. **Plan**: タスクのゴールと受入条件を確認する
2. **Create**: `hal task create` でタスクを作成
3. **Step**: `hal step add` でステップを分解 → `hal step start` → 作業 → `hal step done`
4. **CCR**: 全ステップ完了後、変更のサマリ (Commit/Change Report) を作成

## Notes Management

中間結果や重要な発見はタスクディレクトリの `notes.md` に直接記録してください。
notes.md はセッションをまたいで引き継がれます。

## Knowledge Management

- `hal context list` で利用可能なスキル・ナレッジを確認
- `hal context show --id <id>` で内容を読み込み（自動的に使用履歴が記録される）
- 作業中にユーザーから再利用可能なフィードバックを受けた場合:
  1. `hal context create --type skill --id <id> --description '<desc>'` でエントリ作成
  2. ファイルに内容を書き込む
  3. `hal context log --id <id> --type updated --message '<msg>'` で変更履歴を記録
