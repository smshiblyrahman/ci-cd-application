import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.0.0',
      uptime: process.uptime(),
    };
  }
}

