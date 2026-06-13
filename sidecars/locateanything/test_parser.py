import unittest

from sidecars.locateanything.parser import parse_elements


class LocateAnythingParserTests(unittest.TestCase):
    def test_parses_ref_label_and_box_tokens(self) -> None:
        elements, warnings = parse_elements(
            query_id="controls",
            answer="<ref>search button</ref><box><100><200><300><260></box>",
            image_width=1000,
            image_height=2000,
            max_boxes=5,
        )

        self.assertEqual(warnings, [])
        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["queryId"], "controls")
        self.assertEqual(elements[0]["label"], "search button")
        self.assertEqual(elements[0]["rawBox1000"], [100, 200, 300, 260])
        self.assertEqual(elements[0]["box"], {
            "x": 100.0,
            "y": 400.0,
            "width": 200.0,
            "height": 120.0,
        })

    def test_skips_invalid_coordinate_order_with_warning(self) -> None:
        elements, warnings = parse_elements(
            query_id="cards",
            answer="<ref>bad card</ref><box><500><200><300><260></box>",
            image_width=1000,
            image_height=2000,
            max_boxes=5,
        )

        self.assertEqual(elements, [])
        self.assertEqual(len(warnings), 1)
        self.assertIn("invalid coordinate order", warnings[0])

    def test_skips_materially_out_of_range_coordinates(self) -> None:
        elements, warnings = parse_elements(
            query_id="text",
            answer="<ref>overflow</ref><box><0><0><1005><200></box>",
            image_width=1000,
            image_height=2000,
            max_boxes=5,
        )

        self.assertEqual(elements, [])
        self.assertEqual(len(warnings), 1)
        self.assertIn("out of normalized bounds", warnings[0])

    def test_caps_boxes_per_query(self) -> None:
        answer = (
            "<ref>one</ref><box><0><0><100><100></box>"
            "<ref>two</ref><box><200><200><300><300></box>"
        )

        elements, warnings = parse_elements(
            query_id="text",
            answer=answer,
            image_width=1000,
            image_height=1000,
            max_boxes=1,
        )

        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["label"], "one")
        self.assertEqual(warnings, ["query text returned more than maxBoxesPerQuery=1; extra boxes were ignored"])


if __name__ == "__main__":
    unittest.main()
