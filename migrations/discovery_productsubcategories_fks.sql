-- Discovery: list every FK pointing at dbo.ProductSubCategories.
-- Run this BEFORE 2026-04-19_align_productsubcategories_with_soft1.sql.
-- Expected: a single row showing dbo.Products.SubCategoryID.
-- If anything else appears, the migration script must be extended to
-- update that other table's FK column too.

SELECT
    fk.name              AS ForeignKey,
    OBJECT_SCHEMA_NAME(fk.parent_object_id) + '.' + OBJECT_NAME(fk.parent_object_id) AS ChildTable,
    cp.name              AS ChildColumn,
    OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.' + OBJECT_NAME(fk.referenced_object_id) AS ParentTable,
    cr.name              AS ParentColumn
FROM sys.foreign_keys fk
INNER JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
INNER JOIN sys.columns cp ON cp.object_id = fk.parent_object_id     AND cp.column_id = fkc.parent_column_id
INNER JOIN sys.columns cr ON cr.object_id = fk.referenced_object_id AND cr.column_id = fkc.referenced_column_id
WHERE fk.referenced_object_id = OBJECT_ID('dbo.ProductSubCategories');
