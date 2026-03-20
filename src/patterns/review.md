# レビュータスク パターン

## 概要
既存のコードやドキュメントをレビューし、問題がなくなるまで修正を繰り返すパターン。
レビュアー（verifier）が指摘 → worker が修正 → 再レビューのループ。

## task.yaml の例

```yaml
steps:
  - id: security-review
    instructions: |
      認証モジュールのセキュリティレビューを実施する。
      対象: src/auth/
      観点:
      - SQL インジェクション
      - XSS
      - CSRF
      - パスワードの平文保存
      - セッション管理の不備
    accept: "セキュリティレビューで指摘事項がゼロであること"
    worker_session: shared
```

## オーケストレーターの動き

```
1. hal spawn worker (修正担当として待機)
2. hal spawn verifier (レビュー実施)
3. verifier: FAIL (指摘あり、詳細を message に記録)
4. orchestrator: hal send で worker に「hal history show で指摘を確認して修正して」
5. worker: 指摘を読んで修正 → work_done
6. hal spawn verifier (再レビュー)
7. verifier: PASS (指摘なし) → 完了
   verifier: FAIL → 4 に戻る
```

## 注意点
- verifier の FAIL message に具体的な指摘を書くことが重要
- worker は hal history show で指摘を読める
- worker_session: shared で修正のコンテキストを保持
- レビュー観点は instructions に明記（verifier が何を見るべきか）
