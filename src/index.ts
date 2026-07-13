import { createApp } from './app';
import { readConfig } from './config';

const config = readConfig();

createApp().listen(config.port);

console.log(`MyChampions server listening on http://localhost:${config.port}`);
