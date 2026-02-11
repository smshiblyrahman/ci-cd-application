import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';

describe('App', () => {
  it('compiles the module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();
  });
});

