import {
  Controller,
  Post,
  Body,
  Param,
  Request,
  UseGuards,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { AIService } from './ai.service';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';

@Controller('/v1/ai')
@UseGuards(JwtAuthGuard)
export class AIController {
  constructor(private readonly aiService: AIService) {}

  @Post('/:clusterId/generate-stream')
  async generateStream(
    @Request() req: any,
    @Param('clusterId') clusterId: string,
    @Body() body: { prompt: string },
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = this.aiService.generateSQLStream(
      clusterId,
      req.user.id,
      body.prompt,
    );

    for await (const chunk of stream) {
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  }

  @Post('/:clusterId/generate')
  async generate(
    @Request() req: any,
    @Param('clusterId') clusterId: string,
    @Body() body: { prompt: string },
  ) {
    return {
      sql: await this.aiService.generateSQL(
        clusterId,
        req.user.id,
        body.prompt,
      ),
    };
  }

  @Post('/explain')
  async explain(@Body() body: { sql: string; mode: 'simple' | 'advanced' }) {
    return {
      explanation: await this.aiService.explainSQL(body.sql, body.mode),
    };
  }

  @Post('/:clusterId/optimize')
  async optimize(
    @Request() req: any,
    @Param('clusterId') clusterId: string,
    @Body() body: { sql: string },
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
