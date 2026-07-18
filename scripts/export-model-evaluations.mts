import { exportStoredModelEvaluations } from "../src/lib/model-evaluation/service";
import { prisma } from "../src/lib/server/prisma";

const limit = Number(process.env.MODEL_EVALUATION_EXPORT_LIMIT ?? 100);

try {
  const result = await exportStoredModelEvaluations(limit);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await prisma.$disconnect();
}
