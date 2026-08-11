import { Body, Controller, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { API_KEY_HEADER } from 'src/common/auth/api-key.guard';
import { PrismaService } from 'src/prisma/prisma.service';

class UpsertUserDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  slackChannelId?: string;

  /** IANA zone name, e.g. "Asia/Dhaka". Quiet hours are evaluated in this zone. */
  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  quietHoursStart?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  quietHoursEnd?: number;
}

@ApiTags('recipients')
@ApiSecurity(API_KEY_HEADER)
@Controller('v1/users')
export class RecipientsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List recipients' })
  list() {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        _count: { select: { devices: true, notifications: true } },
      },
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one recipient' })
  async findOne(@Param('id') id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { devices: { where: { disabledAt: null } }, preferences: true },
    });
    if (!user) throw new NotFoundException(`Unknown user "${id}"`);
    return user;
  }

  @Post()
  @ApiOperation({ summary: 'Create a recipient' })
  create(@Body() dto: UpsertUserDto) {
    return this.prisma.user.create({ data: dto });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a recipient (timezone, quiet hours, addresses)' })
  update(@Param('id') id: string, @Body() dto: UpsertUserDto) {
    return this.prisma.user.update({ where: { id }, data: dto });
  }
}
