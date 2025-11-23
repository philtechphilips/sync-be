import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsBoolean,
} from 'class-validator';
import { Language } from '../enums/language.enum';
import { Currency } from '../enums/currency.enum';
import { Theme } from '../enums/theme.enum';

export class WorkspaceSettingsDto {
  @IsNotEmpty()
  default_language: string;

  @IsNotEmpty()
  default_currency: string;

  @IsString()
  @IsNotEmpty()
  default_timezone: string;

  @IsEnum(Theme)
  @IsNotEmpty()
  theme: Theme;
}
