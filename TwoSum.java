import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * 两数之和（Two Sum）
 *
 * 题目：给定一个整数数组 nums 和一个目标值 target，
 *       请找出数组中两个数，使它们的和等于 target，并返回这两个数的下标。
 *
 * 思路：一次遍历 + 哈希表（时间复杂度 O(n)，空间复杂度 O(n)）。
 *       遍历到 nums[i] 时，检查 target - nums[i] 是否已经出现过；
 *       出现过则直接返回两个下标，否则把 nums[i] 及其下标存入表中。
 */
public class TwoSum {

    /** 返回两个下标；若不存在解则返回空数组。 */
    public static int[] twoSum(int[] nums, int target) {
        Map<Integer, Integer> seen = new HashMap<>(); // value -> index
        for (int i = 0; i < nums.length; i++) {
            int complement = target - nums[i];
            if (seen.containsKey(complement)) {
                return new int[] { seen.get(complement), i };
            }
            seen.put(nums[i], i);
        }
        return new int[0];
    }

    public static void main(String[] args) {
        int[] nums = { 2, 7, 11, 15 };
        int target = 9;

        int[] result = twoSum(nums, target);
        if (result.length == 2) {
            System.out.println("nums = " + Arrays.toString(nums) + ", target = " + target);
            System.out.println("输出: [" + result[0] + ", " + result[1] + "]");
            System.out.println("验证: nums[" + result[0] + "] + nums[" + result[1] + "] = "
                    + (nums[result[0]] + nums[result[1]]));
        } else {
            System.out.println("无解");
        }
    }
}
