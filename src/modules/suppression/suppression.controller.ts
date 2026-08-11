import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Channel, SuppressionReason } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { API_KEY_HEADER } from 'src/common/auth/api-key.guard';
import { SuppressionService } from './suppression.service';

class UpsertSuppressionDto {
  @IsEnum(Channel)
  channel!: Channel;

  @IsString()
  address!: string;

  @IsOptional()
  @IsEnum(SuppressionReason)
  reason?: SuppressionReason;

  @IsOptional()
  @IsString()
  detail?: string;
}

class RemoveSuppressionDto {
  @IsEnum(Channel)
  channel!: Channel;

  @IsString()
  address!: string;
}

@ApiTags('suppression')
@ApiSecurity(API_KEY_HEADER)
@Controller('v1/suppressions')
export class SuppressionController {
  constructor(private readonly suppression: SuppressionService) {}

  @Get()
  @ApiOperation({ summary: 'List suppressed addresses' })
  list(
    @Query('channel') channel?: Channel,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ) {
    return this.suppression.list({ channel, limit: Math.min(limit, 500) });
  }

  @Post()
  @ApiOperation({ summary: 'Manually suppress an address' })
  add(@Body() dto: UpsertSuppressionDto) {
    return this.suppression.add(
      dto.channel,
      dto.address,
      dto.reason ?? SuppressionReason.MANUAL,
      dto.detail,
    );
  }

  /** Escape hatch for the case where a user fixed their mailbox and asks to be re-enabled. */
  @Delete()
  @ApiOperation({ summary: 'Remove an address from the suppression list' })
  async remove(@Body() dto: RemoveSuppressionDto) {
    await this.suppression.remove(dto.channel, dto.address);
    return { removed: true };
  }
}
