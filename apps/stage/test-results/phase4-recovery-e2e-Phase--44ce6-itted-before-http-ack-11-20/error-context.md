# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: phase4-recovery-e2e.test.ts >> Phase 4 Stage recovery: core_observation_committed_before_http_ack 11/20
- Location: test/browser/phase4-recovery-e2e.test.ts:44:5

# Error details

```
Error: Channel closed
```

```
Error: stage e2e teardown was not clean: runtime exited before shutdown: SIGTERM
runtime-tail: 0) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
(Use `node --trace-warnings ...` to show where the warning was created)
{"level":"info","time":1788755289998,"service":"bellis-runtime","version":"0.1.0-phase4-effects-e2e","host":"127.0.0.1","port":53666,"instanceId":"0220ecb7-067b-4ffd-8ca4-7b568f72ae59","event":"runtime_listening"}
{"level":"info","time":1788755290225,"service":"bellis-runtime","version":"0.1.0-phase4-effects-e2e","sessionId":"b1866f4a-6bf8-411c-ba46-6f6bc0eae910","traceId":"5604f089a050cfc2f148fd9335e102d8","event":"runtime_session_created"}

```

```
Error: browserContext.close: Target page, context or browser has been closed
```