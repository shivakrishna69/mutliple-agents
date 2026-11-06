/**
 * Indexes department knowledge again: puts every READY and FAILED knowledge document (or one
 * department's) back in the ingestion queue. The running backend's sweep then reads and indexes them
 * within KNOWLEDGE_BASE_SETTINGS.SWEEP_INTERVAL_MS; each document's old chunks are evicted first, so
 * this is safe to run at any time. Use it when Qdrant lost its data (its volume is not part of the
 * database backup: every chunk can be rebuilt from the documents kept in MongoDB), or after the
 * embedding model or the chunking rules changed. Documents being processed or deleted are left alone.
 *
 * It talks to MongoDB directly (MONGO_URI), so only someone with server and database access can use it:
 *   node scripts/reindexKnowledge.js                       every department
 *   node scripts/reindexKnowledge.js <departmentId>        one department
 *   (on the server: nsk exec backend node scripts/reindexKnowledge.js)
 *
 * Exit codes: 0 done, 1 invalid arguments, 3 configuration or database error.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { requeueKnowledgeDocuments } from '../services/knowledge/knowledgeBaseService.js';

async function main() {
  const [departmentId, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || (departmentId && !mongoose.isObjectIdOrHexString(departmentId))) {
    console.error('Usage: node scripts/reindexKnowledge.js [departmentId]');
    return 1;
  }
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set');
    return 3;
  }
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const requeued = await requeueKnowledgeDocuments({ departmentId: departmentId ?? null });
    console.log(
      `${requeued} knowledge document(s) queued to be indexed again${departmentId ? ` in department ${departmentId}` : ''}`,
    );
    return 0;
  } catch (scriptError) {
    console.error(`Re-indexing failed: ${scriptError.message}`);
    return 3;
  } finally {
    await mongoose.disconnect();
  }
}

process.exitCode = await main();
