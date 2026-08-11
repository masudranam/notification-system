import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { API_KEY_HEADER } from 'src/common/auth/api-key.guard';
import { TopicsService } from './topics.service';

@ApiTags('topics')
@ApiSecurity(API_KEY_HEADER)
@Controller('v1/topics')
export class TopicsController {
  constructor(private readonly topics: TopicsService) {}

  @Get()
  @ApiOperation({ summary: 'List topics with their default channels and payload schemas' })
  list() {
    return this.topics.list();
  }
}
