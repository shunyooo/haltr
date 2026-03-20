# 実装タスク パターン

## 概要
accept 条件（テスト、動作確認等）を満たすまで実装→検証のループを回すパターン。
最も基本的なパターン。

## task.yaml の例

```yaml
steps:
  - id: auth
    instructions: |
      JWT 認証を実装する。
      - POST /api/auth/login でメール+パスワードを受け取り JWT を返す
      - ミドルウェアで Authorization ヘッダーを検証
      - 失敗時は 401 を返す
      - bcrypt でパスワードハッシュ
    accept: "npm test -- --grep auth が exit 0 で通ること"

  - id: crud
    instructions: |
      タスクの CRUD API を実装する。
      - POST/GET/PATCH/DELETE /api/tasks
      - 認証必須
      - ユーザーごとにデータ分離
    accept:
      - id: tests
        check: "npm test -- --grep tasks が exit 0"
      - id: manual
        type: human
        check: "ブラウザで /tasks を開いて CRUD 操作ができること"
```

## オーケストレーターの動き

```
1. hal spawn worker --step auth
2. worker: 実装 → work_done
3. hal spawn verifier --step auth
4. verifier: PASS → hal next で次のステップへ
   verifier: FAIL → hal send で修正指示 → 2 に戻る
```

## 注意点
- accept が具体的で測定可能であること（「ちゃんと動く」はNG）
- 複数の accept がある場合、全て PASS で完了
- human type の accept は verifier ではなくオーケストレーターが人間に確認
- worker_session: shared を使えばステップ間でコンテキスト共有
