import express from 'express';
import { loadConfig } from './config';

const config = loadConfig();

const app = express();
app.use(express.json());

app.post('/request-credential', (_req, res) => {
  res.status(501).json({ error: 'not implemented yet' });
});

app.post('/reclaim-expired', (_req, res) => {
  res.status(501).json({ error: 'not implemented yet' });
});

app.listen(config.port, () => {
  console.log(`OXA Broker listening on http://localhost:${config.port} (port ${config.port})`);
});
