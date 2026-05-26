-- Backfill OfferDetails.IsService and ServiceType from Products table
-- for rows that have a linked ProductID but IsService is NULL/0 while the product is a service.
--
-- Run the SELECT first to preview affected rows, then run the UPDATE.

-- PREVIEW
SELECT
  od.ID         AS OfferDetailID,
  od.OfferID,
  od.PartNumber,
  od.ModelNumber,
  od.IsService  AS OD_IsService,
  od.IsPrintable AS OD_IsPrintable,
  p.IsService   AS Product_IsService,
  p.ServiceType AS Product_ServiceType
FROM dbo.OfferDetails od
INNER JOIN dbo.Products p ON p.ID = od.ProductID
WHERE p.IsService = 1
  AND ISNULL(od.IsService, 0) = 0
ORDER BY od.OfferID, od.ID;

-- UPDATE
UPDATE od
SET
  od.IsService  = 1,
  -- Copy ServiceType from product if the offer detail doesn't already have one
  od.ServiceType = COALESCE(od.ServiceType, p.ServiceType),
  -- If IsPrintable is NULL, default to printable (1) for service rows
  od.IsPrintable = CASE WHEN od.IsPrintable IS NULL THEN 1 ELSE od.IsPrintable END
FROM dbo.OfferDetails od
INNER JOIN dbo.Products p ON p.ID = od.ProductID
WHERE p.IsService = 1
  AND ISNULL(od.IsService, 0) = 0;

-- Verify: should return 0 rows after the update
SELECT COUNT(*) AS StillMissing
FROM dbo.OfferDetails od
INNER JOIN dbo.Products p ON p.ID = od.ProductID
WHERE p.IsService = 1
  AND ISNULL(od.IsService, 0) = 0;
