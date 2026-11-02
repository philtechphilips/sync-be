import {
  Controller,
  Post,
  Body,
  Param,
  Request,
  UseGuards,
  Res,
} from '@nestjs/common';
import type { Request as ExpressRequest, Response } from 'express';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AIService } from './ai.service';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';

class PromptDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  prompt: string;
}

class SqlDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50_000)
  sql: string;

  @IsOptional()
  @IsIn(['simple', 'advanced'])
  mode?: 'simple' | 'advanced';
}

@Controller('/v1/ai')
@UseGuards(JwtAuthGuard)
export class AIController {
  constructor(private readonly aiService: AIService) {}

  @Post('/:clusterId/generate-stream')
  async generateStream(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('clusterId') clusterId: string,
    @Body() body: PromptDto,
    @Res() res: Response,
  ) {
    // Stop paying for tokens if the browser goes away mid-stream.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    try {
      const stream = this.aiService.generateSQLStream(
        clusterId,
        req.user.id,
        body.prompt,
        abort.signal,
      );
      for await (const chunk of stream) {
        res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
    } catch (error) {
      if (!abort.signal.aborted) {
        res.write(
          `data: ${JSON.stringify({ error: (error as Error).message || 'AI request failed' })}\n\n`,
        );
      }
    } finally {
      res.end();
    }
  }

  @Post('/:clusterId/generate')
  async generate(
    @Request() req: any,
    @Param('clusterId') clusterId: string,
    @Body() body: PromptDto,
  ) {
    return {
      sql: await this.aiService.generateSQL(
        clusterId,
        req.user.id,
        body.prompt,
      ),
    };
  }

  @Post('/:clusterId/explain')
  async explain(
    @Request() req: any,
    @Param('clusterId') clusterId: string,
    @Body() body: SqlDto,
  ) {
    return {
      explanation: await this.aiService.explainSQL(
        clusterId,
        req.user.id,
        body.sql,
        body.mode ?? 'simple',
      ),
    };
  }

  @Post('/:clusterId/optimize')
  async optimize(
    @Request() req: any,
    @Param('clusterId') clusterId: string,
    @Body() body: SqlDto,
  ) {
    return {
      suggestions: await this.aiService.optimizeSQL(
        clusterId,
        req.user.id,
        body.sql,
      ),
    };
  }
}
