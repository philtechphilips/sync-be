import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { ClustersService } from '../clusters/clusters.service';
import { ClusterType } from '../clusters/entities/cluster.entity';

@Injectable()
export class AIService {
  private readonly openai: OpenAI;

  constructor(private readonly clustersService: ClustersService) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  private getSQLSystemPrompt(clusterType: string): string {
    if (clusterType === ClusterType.MSSQL) {
      return `You are a professional T-SQL (Microsoft SQL Server) expert. Generate valid T-SQL code based on the provided schema. Only return raw SQL — no explanations, no markdown, no code fences.
STRICT T-SQL RULES — never violate these:
- Use GETDATE() instead of NOW()
- Use MONTH(GETDATE()), YEAR(GETDATE()), DAY(GETDATE()) instead of EXTRACT(... FROM ...)
- Use TOP N instead of LIMIT N
- Use DATEADD / DATEDIFF for date arithmetic
- Use ISNULL() instead of COALESCE where single-arg fallback is needed
- Never use PostgreSQL or MySQL-only functions`;
    }
    if (clusterType === ClusterType.POSTGRES) {
      return `You are a professional PostgreSQL expert. Generate valid PostgreSQL code based on the provided schema. Only return raw SQL — no explanations, no markdown, no code fences.
STRICT PostgreSQL RULES — never violate these:
- Use NOW() or CURRENT_TIMESTAMP for current time
- Use EXTRACT(PART FROM timestamp) for date parts
- Use LIMIT N instead of TOP N
- Never use T-SQL or MySQL-only functions`;
    }
    return `You are a professional SQL expert for ${clusterType}. Generate valid SQL code based on the provided schema. Only return raw SQL — no explanations, no markdown, no code fences.`;
  }

  async generateSQL(clusterId: string, userId: string, prompt: string) {
    const cluster = await this.clustersService.findOne(clusterId, userId);
    const rawSchema = await this.clustersService.getSchema(clusterId, userId);
    const compactSchema = this.getCompressedSchema(rawSchema);

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: this.getSQLSystemPrompt(cluster.type),
        },
        {
          role: 'user',
          content: `Schema: ${compactSchema}\n\nObjective: "${prompt}"`,
        },
      ],
    });

    return response.choices[0].message.content
      ?.trim()
      .replaceAll(/```sql|```/g, '');
  }

  async *generateSQLStream(clusterId: string, userId: string, prompt: string) {
    const cluster = await this.clustersService.findOne(clusterId, userId);
    const rawSchema = await this.clustersService.getSchema(clusterId, userId);
    const compactSchema = this.getCompressedSchema(rawSchema);

    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: this.getSQLSystemPrompt(cluster.type),
        },
        {
          role: 'user',
          content: `Schema: ${compactSchema}\n\nObjective: "${prompt}"`,
        },
      ],
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        yield content.replaceAll(/```sql|```/g, '');
      }
    }
  }

  async explainSQL(sql: string, mode: 'simple' | 'advanced') {
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a database consultant. Explain the provided SQL query in ${mode} terms. ${mode === 'simple' ? 'Avoid technical jargon.' : 'Include technical details like joins and aggregation logic.'}`,
        },
        {
          role: 'user',
          content: `Query: ${sql}`,
        },
      ],
    });

    return response.choices[0].message.content;
  }

  async optimizeSQL(clusterId: string, userId: string, sql: string) {
    const cluster = await this.clustersService.findOne(clusterId, userId);
    const rawSchema = await this.clustersService.getSchema(clusterId, userId);
    const compactSchema = this.getCompressedSchema(rawSchema);

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a database performance tuner for ${cluster.type === ClusterType.MSSQL ? 'SQL Server (T-SQL)' : cluster.type}. Suggest query optimizations and indexing strategies. Use only syntax valid for ${cluster.type === ClusterType.MSSQL ? 'T-SQL (GETDATE, DATEADD, TOP, etc.)' : cluster.type}. Be concise and technical.`,
        },
        {
          role: 'user',
          content: `Schema: ${compactSchema}\n\nQuery to optimize: ${sql}`,
        },
      ],
    });

    return response.choices[0].message.content;
  }

  /**
   * Compresses the flat schema list into a token-efficient text format.
   * Maps tableName to a concise list of columns and their types.
   */
  private getCompressedSchema(rawSchema: any[]): string {
    const tables: Record<string, string[]> = {};
    const fks: string[] = [];

    rawSchema.forEach((row) => {
      const table = row.tableName;
      if (!tables[table]) tables[table] = [];
      tables[table].push(`${row.name}(${row.type})`);

      if (row.referencedTable) {
        fks.push(
          `${table}.${row.name} -> ${row.referencedTable}.${row.referencedColumn}`,
        );
      }
    });

    console.log(rawSchema);

    return (
      Object.entries(tables)
        .map(([name, cols]) => `Table ${name} [${cols.join(', ')}]`)
        .join('; ') + (fks.length > 0 ? ` | Relations: ${fks.join(', ')}` : '')
    );
  }
}
