import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
console.log('node:sqlite OK');
console.log('sqlite version:', db.prepare('select sqlite_version() v').get().v);

db.exec('create table t(a integer primary key, b text) strict');
db.prepare('insert into t(b) values (?)').run('x');
console.log('strict + prepared:', JSON.stringify(db.prepare('select * from t').all()));

console.log('json_valid:', db.prepare("select json_valid('{}') v").get().v);
console.log('journal_mode:', JSON.stringify(db.prepare('pragma journal_mode').get()));

// 事务与 IMMEDIATE
db.exec('begin immediate');
db.prepare('insert into t(b) values (?)').run('y');
db.exec('commit');
console.log('rows after tx:', db.prepare('select count(*) c from t').get().c);

// 窗口函数 / CTE / UPSERT / RETURNING
const r = db
  .prepare('insert into t(b) values (?) returning a, b')
  .get('z');
console.log('returning:', JSON.stringify(r));

db.close();
