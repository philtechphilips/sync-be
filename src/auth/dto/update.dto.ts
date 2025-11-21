import { PartialType } from '@nestjs/mapped-types';
import { RegisterAuthDto } from './register.dto';

export class UpdateAuthDto extends PartialType(RegisterAuthDto) {}
