import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ArrayMaxSize,
  ArrayNotEmpty,
} from 'class-validator';

export class ExecuteQueryDto {
  @IsString()
  @MaxLength(5_000_000)
  query: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  limit?: number;
}

export class UpdateRowsDto {
  @IsObject()
  data: Record<string, unknown>;

  @IsObject()
  where: Record<string, unknown>;
}

export class DeleteRowsDto {
  @IsOptional()
  @IsObject()
  where?: Record<string, unknown>;

  /** Delete several rows in one transaction. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10_000)
  @IsObject({ each: true })
  wheres?: Record<string, unknown>[];
}

export class SyncSchemaDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  tableNames: string[];

  @IsOptional()
  @IsBoolean()
  withData?: boolean;

  /** Must be true to change a cluster marked as production. */
  @IsOptional()
  @IsBoolean()
  confirmProduction?: boolean;
}

export class RestoreDto {
  @IsIn(['sql', 'csv', 'json'])
  format: 'sql' | 'csv' | 'json';

  @IsObject()
  data: Record<string, unknown>;
}
