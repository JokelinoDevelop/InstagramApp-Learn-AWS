# AWS-007 — Image metadata model

## Remember this first

**S3 stores the image bytes. DynamoDB stores the application record describing the image and pointing to those bytes.**

We can list a user's images, check ownership, and inspect upload status without downloading files or requesting S3 metadata. We retrieve the bytes from S3 when displaying or downloading an image.

These are design notes from our learning discussion; persistence has not been implemented by this task.

## Initial Image model

| Field | Application type | Meaning |
| --- | --- | --- |
| `imageId` | UUIDv7, stored as a string | Generated once per image upload; the primary application identifier and table partition key. |
| `userId` | User ID, stored as a string | References the existing owner. Match the user model's ID format; do not generate a new user ID per image. |
| `objectKey` | String | Identifies the file within the configured S3 bucket. Bucket name plus key identifies its storage location. |
| `originalFilename` | String | Filename supplied at upload, such as `holiday.jpg`; useful for display or suggested download names. |
| `contentType` | String | MIME type, such as `image/jpeg`, `image/png`, or `image/webp`. |
| `status` | Application enum, stored as a string | `pending_upload`, `uploaded`, or `failed`. |
| `createdAt` | UTC timestamp, stored as a string | When the application creates the DynamoDB item, not when the upload finishes. Use one fixed timestamp format and precision. |

DynamoDB has no native UUID, timestamp, or enum type. The application validates these meanings and allowed values.

Chosen object-key pattern: `{userId}/{imageId}/{originalFilename}`.

- The image ID prevents collisions when a user uploads two files with the same name.
- The user ID provides a grouping prefix; it does not enforce authorization.
- Slashes are part of the S3 key, not actual directories.
- Including the original filename is optional; it can also live only in DynamoDB. Handle user-supplied filenames deliberately when constructing keys.

## Storage responsibilities

| S3 | DynamoDB |
| --- | --- |
| Encoded image bytes | The Image model above |
| Object key and object metadata, including `Content-Type` | Ownership and application lifecycle state |
| Serves the file when requested with appropriate authorization | Provides metadata lookups and user image lists |

S3 also supports metadata; the distinction is about workload and access needs. DynamoDB is suited to small structured application records, while S3 is suited to storing and serving files. DynamoDB items have a 400 KB maximum, which typical photos can exceed.

A filename extension or uploader-supplied MIME type is a claim, not proof of the actual format. Validate the bytes before trusting the file. Keep the S3 `Content-Type` and application metadata consistent with the validated format.

## Upload status

| State | Meaning |
| --- | --- |
| `pending_upload` | The application has not confirmed upload completion. The file may already exist while event handling is delayed. |
| `uploaded` | The application has confirmed successful storage in S3. This does not imply resizing or other processing occurred. |
| `failed` | A known failure occurred, or the upload deadline passed and reconciliation confirmed the object was absent. |

An S3 ObjectCreated event can trigger confirmation. The handler must associate the expected object with the correct image record. S3 notifications can be duplicated or arrive out of order, so handling must tolerate repeats and delays.

No success event does not prove failure. After an upload deadline, check the expected S3 object: reconcile the record if it exists; treat it as unsuccessful if absent. A permission or service error leaves the outcome unresolved.

We chose one unsuccessful state because separate `failed_upload` and `expired` states do not currently require different application behavior. Failure reasons can be added if a concrete need arises.

S3 and DynamoDB do not share a transaction. Plan reconciliation and cleanup for incomplete records and orphaned files. Deleting a DynamoDB item does not delete its S3 object.

## DynamoDB vocabulary and access paths

- **Table:** a collection of items.
- **Item:** one record, such as one image's metadata.
- **Attribute:** one field of an item.
- **Access pattern:** a request the application needs to support.
- **Access path:** the table or index key structure used to fulfill that request efficiently.

| Access pattern | Access path | Operation |
| --- | --- | --- |
| Fetch one image by ID | Main table: partition key `imageId`, no sort key | `GetItem` |
| List a user's images in creation-time order | GSI: partition key `userId`, sort key `createdAt` | `Query` |

A global secondary index (GSI) is an automatically maintained alternate lookup structure. It stores its keys, the table keys, and selected additional attributes called projections. The image list needs suitable projected fields, such as `status`, or additional table reads to retrieve them.

`Query` requires a specific partition-key value for the table or index being queried. Adding `userId` as a sort key under `imageId` would not enable a lookup using only `userId`.

`Scan` reads through a table or index. Filtering afterward does not avoid reading unrelated items. An ordinary attribute is not automatically an efficient Query key.

GSI keys need not be unique: two images can share a user and timestamp. Their relative order is unspecified. Consistently formatted UTC timestamps sort chronologically; newest-first queries use descending sort-key order.

## Writes and conditions

| Operation | Important behavior |
| --- | --- |
| `PutItem` | Creates or completely replaces an item with the same primary key. Omitted attributes disappear. |
| `UpdateItem` | Changes selected attributes, preserving others; creates an item if absent unless prevented by a condition. |
| `DeleteItem` | Deletes the metadata item only. |

Conditions are checked atomically with a write. They prevent an outdated read or decision from causing an unsafe update.

- Creating a new record: require that its key does not already exist.
- Updating an existing record: require that `imageId` exists.
- Marking a pending upload failed: require that it exists and its current status is `pending_upload`.

The final condition prevents a delayed failure handler from overwriting `uploaded`. A rejected condition should be interpreted deliberately: it might mean a duplicate event, missing item, or competing update. The complete policy for success events and reconciliation still needs to be defined before implementation.

## Read consistency

- **Eventually consistent:** may briefly return older committed data; the default.
- **Strongly consistent:** reflects successful writes completed before the read; available on the main table.
- **GSI reads:** always eventually consistent.

An old status in the GSI list does not prove the write failed. Use a strongly consistent main-table `GetItem` when freshness is necessary. Strong reads do not lock records; conditional writes still protect later updates.

## Pagination

One Query evaluates up to 1 MB of data, or up to its `Limit` item count, then applies any filter.

- `LastEvaluatedKey`: the bookmark returned by DynamoDB.
- `ExclusiveStartKey`: supply that bookmark in the next Query, preserving the query criteria and ordering.
- No bookmark means the end was reached. A bookmark means continue to determine whether more matching results remain.

`Limit = 20` means up to 20 items evaluated, not necessarily 20 uploaded images returned. If all 20 are filtered out, the response can be empty and still contain a bookmark. Later batches may contain uploaded images.

The application may need multiple database batches to fill one visible page. Bound that work, and load further pages when the user needs them. Pagination is not a frozen snapshot of data while concurrent changes occur.

## Capacity and cost

**On-demand:** pay for read/write units consumed, plus storage and other enabled features. A sensible initial choice for intermittent learning traffic.

**Provisioned:** allocate read/write capacity per second and pay for the allocated capacity, even when unused; optional auto scaling adjusts it.

For ordinary nontransactional operations:

| Work | Units |
| --- | --- |
| Write an item up to 1 KB | 1 write unit |
| Strongly consistent GetItem up to 4 KB | 1 read unit |
| Eventually consistent GetItem up to 4 KB | 0.5 read unit |

Writes round up in 1 KB increments; reads in 4 KB increments. Updating a 1.5 KB item consumes 2 table write units even if only `status` changes. Updates use the larger of the before/after item sizes.

Queries aggregate evaluated item sizes for capacity calculations; do not apply GetItem rounding separately to each query result. Filters and returning fewer attributes do not reduce capacity for data already read.

GSIs add storage and maintenance writes. A status update affects the index if status is projected. Reads from the GSI consume index read units. Avoid creating indexes without an actual access need.

## Operational habits

- Fetching metadata by ID is not authorization: verify ownership or visibility before granting file access.
- Keep storage private where appropriate, use least-privilege IAM, encryption at rest, and HTTPS in transit.
- Observe errors, conditional-write rejections, throttling, and stuck uploads rather than silently ignoring them.
- Monitor usage, avoid repeated scans, and remove unused learning resources and retained backups when no longer needed.

## AWS references

- [DynamoDB core concepts and keys](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.CoreComponents.html)
- [Storing large content in S3 with DynamoDB references](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-use-s3-too.html)
- [S3 object metadata](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html)
- [S3 notification delivery considerations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html)
- [Global secondary indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html)
- [Item operations](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WorkingWithItems.html)
- [Read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html)
- [Query pagination](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.Pagination.html)
- [Read/write unit calculations](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html)
- [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/)
