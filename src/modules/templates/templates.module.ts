import { Module } from '@nestjs/common';
import { TemplateService } from './template.service';
import { TemplatesController } from './templates.controller';

@Module({
  controllers: [TemplatesController],
  providers: [TemplateService],
  exports: [TemplateService],
})
export class TemplatesModule {}
