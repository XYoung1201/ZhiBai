// 本地开发：书库指向本机书籍目录，数据放 devdata/
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.BOOKS_DIR ||= path.resolve(here, '../..');
process.env.DATA_DIR ||= path.resolve(here, '../devdata');
process.env.APP_DIR ||= path.resolve(here, '../app');
process.env.PORT ||= '8730';
await import('./server.js');
