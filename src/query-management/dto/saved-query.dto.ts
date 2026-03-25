import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreateSavedQueryDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  query: string;

  @IsOptional()
  @IsUUID()
  clusterId?: string;

  @IsOptional()
  @IsUUID()
  collectionId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class UpdateSavedQueryDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsUUID()
  clusterId?: string;

  @IsOptional()
  @IsUUID()
  collectionId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
