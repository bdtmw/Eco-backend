"# rock01" 
"# Eco-backend" 

## Tests

```bash
npm run test:security   # no database needed (auth gates, validation, CSRF, rate limit, cron secret)
npm test                # everything, incl. database-backed money/ownership tests
```

The database tests need a MongoDB **replica set** (transactions are used):

- default: `mongodb-memory-server` starts one in memory (downloads a `mongod` binary on first run), or
- set `MONGO_TEST_URI` to a dedicated test database (the URI must contain `test`; collections are wiped between tests).

Never point `MONGO_TEST_URI` at production data.
