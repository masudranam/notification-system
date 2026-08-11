import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Channel } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsDate,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateNotificationDto {
  @ApiProperty({ description: 'Recipient user id', example: 'cku1abc...' })
  @IsString()
  @MinLength(1)
  userId!: string;

  @ApiProperty({ description: 'Registered topic key', example: 'order.shipped' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  topicKey!: string;

  @ApiProperty({
    description: "Template variables. Validated against the topic's JSON Schema.",
    example: { orderId: 'A-1001', carrier: 'DHL', trackingNumber: 'TRK123' },
  })
  @IsObject()
  data!: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Restrict the fan-out to these channels. Still filtered by user preferences — this narrows ' +
      'the topic defaults, it does not override what the user asked for.',
    enum: Channel,
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(Channel, { each: true })
  channels?: Channel[];

  @ApiPropertyOptional({
    description: 'Send at this time instead of immediately (ISO 8601).',
    example: '2026-08-12T09:00:00.000Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  scheduledAt?: Date;
}
