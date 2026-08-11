import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Channel } from '@prisma/client';
import { IsEnum, IsObject, IsOptional, IsString } from 'class-validator';
import { API_KEY_HEADER } from 'src/common/auth/api-key.guard';
import { PrismaService } from 'src/prisma/prisma.service';
import { TemplateService } from './template.service';

class PreviewTemplateDto {
  @IsEnum(Channel)
  channel!: Channel;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsObject()
  data!: Record<string, unknown>;
}

@ApiTags('templates')
@ApiSecurity(API_KEY_HEADER)
@Controller('v1/templates')
export class TemplatesController {
  constructor(
    private readonly templates: TemplateService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List templates' })
  list(@Query('topicKey') topicKey?: string) {
    return this.prisma.template.findMany({
      where: topicKey ? { topicKey } : undefined,
      select: {
        id: true,
        topicKey: true,
        channel: true,
        locale: true,
        version: true,
        subject: true,
        isActive: true,
      },
      orderBy: [{ topicKey: 'asc' }, { channel: 'asc' }, { version: 'desc' }],
    });
  }

  /** Renders a template without sending anything — the fast feedback loop for template work. */
  @Post(':topicKey/preview')
  @ApiOperation({ summary: 'Render a template against sample data without sending' })
  preview(@Param('topicKey') topicKey: string, @Body() dto: PreviewTemplateDto) {
    return this.templates.preview(topicKey, dto.channel, dto.locale ?? 'en', dto.data);
  }
}
