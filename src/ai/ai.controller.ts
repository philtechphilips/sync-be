import {
  Controller,
  Post,
  Body,
  Param,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AIService } from './ai.service';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';

@Controller('/v1/ai')
@UseGuards(JwtAuthGuard)
export class AIController {
  constructor(private readonly aiService: AIService) {}

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
