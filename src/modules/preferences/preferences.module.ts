import { Global, Module } from '@nestjs/common';
import { SuppressionModule } from 'src/modules/suppression/suppression.module';
import { PreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';
import { UnsubscribeController } from './unsubscribe.controller';
import { UnsubscribeService } from './unsubscribe.service';

// Global because every channel processor needs UnsubscribeService to build List-Unsubscribe links.
@Global()
@Module({
  imports: [SuppressionModule],
  controllers: [PreferencesController, UnsubscribeController],
  providers: [PreferencesService, UnsubscribeService],
  exports: [PreferencesService, UnsubscribeService],
})
export class PreferencesModule {}
