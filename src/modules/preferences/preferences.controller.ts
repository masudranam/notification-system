import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Channel, DigestMode } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, ValidateNested } from 'class-validator';
import { API_KEY_HEADER } from 'src/common/auth/api-key.guard';
import { PreferencesService } from './preferences.service';

class PreferenceUpdateDto {
  @IsString()
  topicKey!: string;

  @IsEnum(Channel)
  channel!: Channel;

  /** Omit to leave unchanged; send null to clear the override and fall back to the topic default. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean | null;

  @IsOptional()
  @IsEnum(DigestMode)
  digest?: DigestMode;
}

class UpdatePreferencesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreferenceUpdateDto)
  updates!: PreferenceUpdateDto[];
}

@ApiTags('preferences')
@ApiSecurity(API_KEY_HEADER)
@Controller('v1/preferences')
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get()
  @ApiOperation({
    summary: 'Effective topic x channel preference matrix (default, override and effective value)',
  })
  get(@Query('userId') userId: string) {
    return this.preferences.getMatrix(userId);
  }

  @Put()
  @ApiOperation({ summary: 'Update preference overrides and digest modes' })
  update(@Query('userId') userId: string, @Body() dto: UpdatePreferencesDto) {
    return this.preferences.upsert(userId, dto.updates);
  }
}
