import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
(async () => {
  for (let i = 0; i < 4; i++) {
    const t = Date.now();
    await p.$queryRaw`SELECT 1`;
    console.log(`SELECT 1 #${i}: ${Date.now() - t}ms`);
  }
  const t2 = Date.now();
  await p.gameSession.findFirst();
  console.log(`findFirst: ${Date.now() - t2}ms`);
  const t3 = Date.now();
  await p.poem.findMany();
  console.log(`poem.findMany(${(Date.now() - t3)}ms)`);
  await p.$disconnect();
})();
