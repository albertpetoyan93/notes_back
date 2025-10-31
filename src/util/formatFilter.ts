import { Op } from "sequelize";

export const formatFilter = (filter: Record<string, string>) => {
  return Object.entries(filter).reduce((acc, [key, value]) => {
    if (value && value.trim()) {
      // Split by comma and filter out empty values
      const values = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      if (values.length > 0) {
        acc[key] = {
          [Op.or]: values.map((item) => ({
            [Op.like]: `%${item}%`,
          })),
        };
      }
    }
    return acc;
  }, {} as Record<string, any>);
};

export const formatExactFilter = (
  filter: Record<string, string | string[]>
) => {
  return Object.entries(filter).reduce((acc, [key, value]) => {
    if (value) {
      // Convert to array if it's a string (comma-separated values)
      const values = Array.isArray(value)
        ? value
        : value.split(",").map((item) => item.trim());

      // Filter out empty values
      const filteredValues = values.filter((item) => item.length > 0);

      if (filteredValues.length > 0) {
        if (filteredValues.length === 1) {
          // Single value - use exact match
          acc[key] = filteredValues[0];
        } else {
          // Multiple values - use IN operator
          acc[key] = {
            [Op.in]: filteredValues,
          };
        }
      }
    }
    return acc;
  }, {} as Record<string, any>);
};

export const formatMultiselectFilter = (
  filter: Record<string, string | string[]>,
  options: {
    exactMatch?: boolean;
    validOptions?: Record<string, string[]>;
  } = {}
) => {
  const { exactMatch = true, validOptions = {} } = options;
  return Object.entries(filter).reduce((acc, [key, value]) => {
    if (value) {
      // Convert to array if it's a string (comma-separated values)
      const values = Array.isArray(value)
        ? value
        : value.split(",").map((item) => item.trim());

      // Filter out empty values
      let filteredValues = values.filter((item) => item.length > 0);

      // Apply valid options filter if specified
      if (validOptions[key]) {
        filteredValues = filteredValues.filter((item) =>
          validOptions[key].includes(item)
        );
      }

      if (filteredValues.length > 0) {
        if (exactMatch) {
          if (filteredValues.length === 1) {
            // Single value - use exact match
            acc[key] = filteredValues[0];
          } else {
            // Multiple values - use IN operator
            acc[key] = {
              [Op.in]: filteredValues,
            };
          }
        } else {
          // Use LIKE queries for pattern matching
          acc[key] = {
            [Op.or]: filteredValues.map((item) => ({
              [Op.like]: `%${item}%`,
            })),
          };
        }
      }
    }
    return acc;
  }, {} as Record<string, any>);
};

/**
 * Clean filter object by removing undefined, null, and empty string values
 * Useful for preparing filters before passing to formatMultiselectFilter or formatFilter
 */
export const cleanFilters = <T extends Record<string, any>>(
  filters: T
): Record<string, NonNullable<T[keyof T]>> => {
  return Object.entries(filters)
    .filter(
      ([_, value]) => value !== undefined && value !== null && value !== ""
    )
    .reduce((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {} as Record<string, NonNullable<T[keyof T]>>);
};
