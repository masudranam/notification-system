import { Module } from '@nestjs/common';
import { MaintenanceProcessor } from './maintenance.processor';

@Module({
  providers: [MaintenanceProcessor],
})
export class MaintenanceModule {}
